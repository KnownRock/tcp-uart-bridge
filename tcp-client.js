const net = require('net');
const { SerialPort } = require('serialport');
const { Transform } = require('stream');
const crypto = require('crypto');
const Logger = require('./logger');

// 日志配置
const logger = Logger.create('TCP-CLIENT', {
    debug: process.env.DEBUG === 'true',
    info: process.env.QUIET !== 'true',
    warn: true,
    error: true,
    verbose: process.env.VERBOSE === 'true'
});

// 配置
const SERIAL_PORT = process.argv[2] || 'COM1';
const BAUD_RATE = parseInt(process.argv[3]) || 115200;
const FLOW_CONTROL = process.argv[4] === 'false' ? false : true;


// 这里的冗余而没有提出成函数，是为了可以更加清晰地看到每个部分的逻辑
// 命令定义
const CMD_DATA = 0x01;
// const CMD_CONNECT = 0x02;
const CMD_DISCONNECT = 0x03;
// const CMD_CLIENT_CLOSE = 0x04;
const CMD_PROGRAM_CLOSE = 0x05;

// 客户端管理
const clients = new Map();

// 创建数据包函数 - 优化格式，使用字节保存信息
function createPacket(cmd, clientId, data, targetHost = '', targetPort = 0) {
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    
    // 将客户端ID转换为16字节的UUID buffer
    let clientIdBuffer;
    if (typeof clientId === 'string' && clientId.length === 32) {
        // 如果是32位hex字符串，转换为16字节
        clientIdBuffer = Buffer.from(clientId, 'hex');
    } else if (typeof clientId === 'string' && clientId.includes('-')) {
        // 如果是标准UUID格式，移除连字符后转换
        clientIdBuffer = Buffer.from(clientId.replace(/-/g, ''), 'hex');
    } else {
        // 否则生成一个新的UUID
        clientIdBuffer = Buffer.from(crypto.randomUUID().replace(/-/g, ''), 'hex');
    }
    
    // 解析IPv4地址为4字节
    let ipBuffer = Buffer.alloc(4);
    if (targetHost) {
        const ipParts = targetHost.split('.').map(part => parseInt(part) || 0);
        ipBuffer = Buffer.from(ipParts.slice(0, 4));
    }
    
    // 优化的数据包格式：
    // 命令(1) + 客户端ID(16) + IPv4地址(4) + 端口(2) + 数据长度(4) + 数据(变长)
    const packet = Buffer.alloc(1 + 16 + 4 + 2 + 4 + dataBuffer.length);
    
    let offset = 0;
    packet.writeUInt8(cmd, offset); offset += 1;
    clientIdBuffer.copy(packet, offset); offset += 16;
    ipBuffer.copy(packet, offset); offset += 4;
    packet.writeUInt16BE(targetPort, offset); offset += 2;
    packet.writeUInt32BE(dataBuffer.length, offset); offset += 4;
    dataBuffer.copy(packet, offset);
    
    return packet;
}

// 数据包处理流
class PacketStream extends Transform {
    constructor(options) {
        super({ ...options, objectMode: false });
        this.buffer = Buffer.alloc(0);
    }

    _transform(chunk, encoding, callback) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        
        // 优化的数据包格式最小长度: 1 + 16 + 4 + 2 + 4 = 27字节
        while (this.buffer.length >= 27) {
            const cmd = this.buffer.readUInt8(0);
            const clientId = this.buffer.subarray(1, 17); // 16字节UUID
            const targetIp = this.buffer.subarray(17, 21); // 4字节IPv4
            const targetPort = this.buffer.readUInt16BE(21);
            const dataLength = this.buffer.readUInt32BE(23);
            
            if (this.buffer.length >= 27 + dataLength) {
                const data = this.buffer.subarray(27, 27 + dataLength);
                this.buffer = this.buffer.subarray(27 + dataLength);

                // 将IP地址转换为字符串
                const targetHost = Array.from(targetIp).join('.');
                
                // 直接触发事件而不是通过流传递
                this.emit('packet', {
                    cmd,
                    clientId: clientId.toString('hex'), // 转换为hex字符串便于查找
                    targetHost,
                    targetPort,
                    data
                });
            } else {
                break;
            }
        }
        
        callback();
    }
}

// 创建到目标端口的连接
function createTargetConnection(clientId, targetHost, targetPort, serialPort) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        
        socket.connect(targetPort, targetHost, () => {
            logger.info(`为客户端 ${clientId} 建立到 ${targetHost}:${targetPort} 的连接`);
            
            const clientInfo = {
                id: clientId,
                socket: socket,
                connected: true,
                targetHost: targetHost,
                targetPort: targetPort
            };
            
            clients.set(clientId, clientInfo);
            
            // 处理目标服务器的响应数据
            socket.on('data', (data) => {
                logger.verbose(`收到目标服务器响应 ${clientId}: ${data.length} 字节`);
                
                // 将响应数据通过串口发送回服务端
                if (serialPort && serialPort.isOpen) {
                    const packet = createPacket(CMD_DATA, clientId, data, targetHost, targetPort);
                    serialPort.write(packet, (err) => {
                        if (err) {
                            logger.error(`串口写入失败 ${clientId}:`, err.message);
                        }
                    });
                } else {
                    logger.warn(`串口未打开，无法发送响应数据 ${clientId}`);
                }
            });
            
            socket.on('close', () => {
                logger.info(`到目标服务器的连接已关闭: ${clientId}`);
                clients.delete(clientId);
                
                // 发送客户端关闭通知给服务器
                if (serialPort && serialPort.isOpen) {
                    const packet = createPacket(CMD_DISCONNECT, clientId, '', targetHost, targetPort);
                    serialPort.write(packet, (err) => {
                        if (err) {
                            logger.error(`发送客户端关闭通知失败 ${clientId}:`, err.message);
                        } else {
                            logger.debug(`发送客户端关闭通知 ${clientId}`);
                        }
                    });
                }
            });
            
            socket.on('error', (err) => {
                logger.error(`目标连接错误 ${clientId}:`, err.message);
                clients.delete(clientId);
            });
            
            resolve(clientInfo);
        });
        
        socket.on('error', (err) => {
            logger.error(`连接到目标失败 ${clientId}:`, err.message);
            reject(err);
        });
    });
}

// 处理接收到的数据包
function handlePacket(packet, serialPort) {
    const { cmd, clientId, targetHost, targetPort, data } = packet;
    
    switch (cmd) {
        case CMD_DATA:
            logger.verbose(`处理数据传输: ${clientId}, 目标: ${targetHost}:${targetPort}, 数据长度: ${data.length}`);
            
            if (clients.has(clientId)) {
                const client = clients.get(clientId);
                if (client.connected && client.socket) {
                    client.socket.write(data, (err) => {
                        if (err) {
                            logger.error(`写入目标失败 ${clientId}:`, err.message);
                        } else {
                            logger.debug(`数据已发送到目标 ${clientId}: ${data.length} 字节`);
                        }
                    });
                }
            } else {
                logger.info(`客户端 ${clientId} 不存在，正在创建到 ${targetHost}:${targetPort} 的新连接...`);
                createTargetConnection(clientId, targetHost, targetPort, serialPort).then(client => {
                    client.socket.write(data, (err) => {
                        if (err) {
                            logger.error(`写入目标失败 ${clientId}:`, err.message);
                        } else {
                            logger.debug(`数据已发送到目标 ${clientId}: ${data.length} 字节`);
                        }
                    });
                }).catch(err => {
                    logger.error(`建立连接并发送数据失败 ${clientId}:`, err.message);
                });
            }
            break;
            
        case CMD_DISCONNECT:
            logger.info(`处理断开连接: ${clientId}`);
            if (clients.has(clientId)) {
                const client = clients.get(clientId);
                if (client.socket) {
                    client.socket.end();
                }
                clients.delete(clientId);
            }
            break;
            
        default:
            logger.warn(`未知命令: ${cmd}`);
            break;
    }
}

// 初始化串口
let serialPort;
try {
    serialPort = new SerialPort({
        path: SERIAL_PORT,
        baudRate: BAUD_RATE,
        rtscts: FLOW_CONTROL,  // 可配置的硬件流控
        autoOpen: false
    });
    
    serialPort.open((err) => {
        if (err) {
            logger.error('串口打开失败:', err.message);
            process.exit(1);
        }
        logger.info(`串口已打开: ${SERIAL_PORT}`);
    });
    
    // 创建数据包处理流
    const packetStream = new PacketStream();
    
    // 处理串口数据
    serialPort.on('data', (data) => {
        packetStream.write(data);
    });
    
    // 处理解析出的数据包
    packetStream.on('packet', (packet) => {
        handlePacket(packet, serialPort);
    });
    
    serialPort.on('error', (err) => {
        logger.error('串口错误:', err.message);
    });
    
} catch (error) {
    logger.error('串口初始化失败:', error.message);
    process.exit(1);
}

// 优雅关闭函数
async function gracefulShutdown() {
    logger.info('\n正在优雅关闭客户端...');
    
    try {
        // 1. 发送程序关闭通知给服务器
        if (serialPort && serialPort.isOpen) {
            logger.info('正在发送程序关闭通知...');
            const programClosePacket = createPacket(CMD_PROGRAM_CLOSE, crypto.randomUUID().replace(/-/g, ''), '', '', 0);
            await new Promise((resolve) => {
                serialPort.write(programClosePacket, (err) => {
                    if (err) {
                        logger.error('发送程序关闭通知失败:', err.message);
                    } else {
                        logger.info('程序关闭通知已发送');
                    }
                    resolve();
                });
            });
            // 给服务器一点时间处理通知
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // 2. 发送客户端关闭通知给服务器
        const notificationPromises = [];
        
        clients.forEach((client, uuid) => {
            if (serialPort && serialPort.isOpen) {
                const packet = createPacket(CMD_DISCONNECT, uuid, '', client.targetHost, client.targetPort);
                notificationPromises.push(
                    new Promise((resolve) => {
                        serialPort.write(packet, (err) => {
                            if (err) {
                                logger.error(`发送客户端关闭通知失败 ${uuid}:`, err.message);
                            } else {
                                logger.debug(`发送客户端关闭通知 ${uuid}`);
                            }
                            resolve();
                        });
                    })
                );
            }
        });
        
        if (notificationPromises.length > 0) {
            logger.info(`正在发送 ${notificationPromises.length} 个客户端关闭通知...`);
            await Promise.all(notificationPromises);
            // 给服务器一点时间处理通知
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // 3. 关闭所有目标连接
        const clientClosePromises = [];
        
        clients.forEach((client, uuid) => {
            if (client.socket && !client.socket.destroyed) {
                clientClosePromises.push(
                    new Promise((resolve) => {
                        const timeout = setTimeout(() => {
                            if (!client.socket.destroyed) {
                                logger.warn(`强制关闭目标连接: ${client.targetHost}:${client.targetPort} (UUID: ${uuid})`);
                                client.socket.destroy();
                            }
                            resolve();
                        }, 3000); // 3秒超时
                        
                        client.socket.once('close', () => {
                            clearTimeout(timeout);
                            logger.info(`目标连接已关闭: ${client.targetHost}:${client.targetPort} (UUID: ${uuid})`);
                            resolve();
                        });
                        
                        client.socket.end();
                    })
                );
            }
        });
        
        if (clientClosePromises.length > 0) {
            logger.info(`正在关闭 ${clientClosePromises.length} 个目标连接...`);
            await Promise.all(clientClosePromises);
            logger.info('所有目标连接已关闭');
        }

        // 4. 清理客户端映射
        clients.clear();

        // 5. 关闭串口
        if (serialPort && serialPort.isOpen) {
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    logger.warn('强制关闭串口');
                    resolve();
                }, 3000); // 3秒超时
                
                serialPort.close(() => {
                    clearTimeout(timeout);
                    logger.info('串口已关闭');
                    resolve();
                });
            });
        }

        logger.info('客户端已优雅关闭');
        process.exit(0);
        
    } catch (err) {
        logger.error('优雅关闭时发生错误:', err.message);
        process.exit(1);
    }
}

// 处理程序退出信号
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// 处理未捕获的异常
process.on('uncaughtException', (err) => {
    logger.error('未捕获的异常:', err);
    gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的Promise拒绝:', reason);
    gracefulShutdown();
});

logger.info('使用方法:');
logger.info('  node tcp-client.js [串口] [目标端口] [目标主机] [波特率]');
logger.info('  例如: node tcp-client.js COM21 22 localhost 115200');
logger.info('');
logger.info('参数说明:');
logger.info(`  串口: ${SERIAL_PORT}`);
logger.info(`  波特率: ${BAUD_RATE}`);
logger.info('');
logger.info('日志级别配置:');
logger.info('  QUIET=true    - 静默模式，只显示错误和警告');
logger.info('  DEBUG=true    - 调试模式，显示详细信息');
logger.info('  VERBOSE=true  - 详细模式，显示所有操作');
logger.info('');
logger.info('按 Ctrl+C 退出');
