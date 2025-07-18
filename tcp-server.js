const net = require('net');
const { SerialPort } = require('serialport');
const { Transform } = require('stream');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Logger = require('./logger');

// 日志配置
const logger = Logger.create('TCP-SERVER', {
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
const MAPPING_FILE = process.argv[5] || 'port-mapping.json';

// 这里的冗余而没有提出成函数，是为了可以更加清晰地看到每个部分的逻辑
// 命令定义
const CMD_DATA = 0x01;
// const CMD_CONNECT = 0x02;
const CMD_DISCONNECT = 0x03;
// const CMD_CLIENT_CLOSE = 0x04;
const CMD_PROGRAM_CLOSE = 0x05;

// 客户端管理
const clientsByPort = new Map(); // localPort -> Map<clientId, clientInfo>

// 端口映射配置
let portMappings = [];
let servers = [];

// 数据包处理流（用于处理从串口接收的响应数据）
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

// 创建数据包 - 优化格式，使用字节保存信息
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

  // 创建数据包处理流来处理返回的数据
  const packetStream = new PacketStream();

  // 处理串口数据
  serialPort.on('data', (data) => {
    packetStream.write(data);
  });

  // 处理从客户端返回的数据包
  packetStream.on('packet', (packet) => {
    handleResponsePacket(packet);
  });

  serialPort.on('error', (err) => {
    logger.error('串口错误:', err.message);
  });

} catch (error) {
  logger.error('串口初始化失败:', error.message);
  process.exit(1);
}

// 处理从客户端返回的响应数据包
function handleResponsePacket(packet) {
  const { cmd, clientId, data } = packet;

  switch (cmd) {
    case CMD_DATA:
      logger.debug(`收到响应数据: ${clientId}, 数据长度: ${data.length}`);

      // 从所有端口的客户端中查找
      let targetClient = null;
      for (const clients of clientsByPort.values()) {
        if (clients.has(clientId)) {
          targetClient = clients.get(clientId);
          break;
        }
      }

      if (targetClient && targetClient.socket && !targetClient.socket.destroyed) {
        targetClient.socket.write(data, (err) => {
          if (err) {
            logger.error(`发送响应数据失败 ${clientId}:`, err.message);
          } else {
            logger.debug(`响应数据已发送到客户端 ${clientId}: ${data.length} 字节`);
          }
        });
      } else {
        logger.warn(`响应数据的客户端不存在: ${clientId}`);
      }
      break;

    case CMD_DISCONNECT:
      logger.info(`处理断开连接: ${clientId}`);
      let disconnected = false;
      for (const clients of clientsByPort.values()) {
        if (clients.has(clientId)) {
          const client = clients.get(clientId);
          if (client.socket && !client.socket.destroyed) {
            client.socket.end(() => {
              logger.info(`客户端连接已关闭: ${client.address} (ID: ${clientId})`);
            });
          }
        }
      }
      if (clientsByPort.has(clientId)) {
        clientsByPort.get(clientId).delete(clientId);
        disconnected = true;
      }
      if (!disconnected) {
        logger.warn(`客户端 ${clientId} 不存在，无法处理断开连接`);
      }
      break;


    case CMD_PROGRAM_CLOSE:
      logger.info(`收到程序关闭通知，开始关闭服务器...`);
      // 异步执行关闭程序，避免阻塞当前处理
      setImmediate(() => {
        gracefulShutdown();
      });
      break;

    default:
      logger.warn(`未知响应命令: ${cmd}`);
      break;
  }
}

// 加载端口映射配置
function loadPortMappings() {
  try {
    const mappingPath = path.resolve(MAPPING_FILE);
    const configData = fs.readFileSync(mappingPath, 'utf8');
    const config = JSON.parse(configData);
    portMappings = config.portMappings;
    logger.info(`已加载 ${portMappings.length} 个端口映射配置`);

    portMappings.forEach(mapping => {
      logger.info(`映射: ${mapping.localPort} -> ${mapping.remoteHost}:${mapping.remotePort} (${mapping.description})`);
    });
  } catch (error) {
    logger.error('加载端口映射配置失败:', error.message);
    logger.info('使用默认配置');
    portMappings = [
      {
        localPort: 8080,
        remoteHost: 'localhost',
        remotePort: 22,
        description: 'SSH转发'
      }
    ];
  }
}

// 根据本地端口查找映射关系
function findMappingByLocalPort(localPort) {
  return portMappings.find(mapping => mapping.localPort === localPort);
}

// 创建多端口TCP服务器
function createMultiPortServers() {
  portMappings.forEach(mapping => {
    const server = net.createServer((socket) => {
      // 生成UUID并转换为hex格式
      const uuid = crypto.randomUUID();
      const clientId = uuid.replace(/-/g, ''); // 移除连字符，得到32位hex字符串
      const clientInfo = {
        id: clientId,
        socket: socket,
        address: `${socket.remoteAddress}:${socket.remotePort}`,
        localPort: mapping.localPort,
        mapping: mapping
      };

      // 按端口分组管理客户端
      if (!clientsByPort.has(mapping.localPort)) {
        clientsByPort.set(mapping.localPort, new Map());
      }
      clientsByPort.get(mapping.localPort).set(clientId, clientInfo);

      logger.info(`客户端连接到端口 ${mapping.localPort}: ${clientInfo.address} (ID: ${clientId})`);
      logger.debug(`映射到: ${mapping.remoteHost}:${mapping.remotePort}`);

      // 处理客户端数据
      socket.on('data', (data) => {
        logger.verbose(`收到数据来自 ${clientInfo.address}: ${data.length} 字节`);

        if (serialPort.isOpen) {
          const packet = createPacket(CMD_DATA, clientId, data, mapping.remoteHost, mapping.remotePort);
          serialPort.write(packet, (err) => {
            if (err) {
              logger.error('串口写入失败:', err.message);
            } else {
              logger.debug(`数据已发送到串口: ${data.length} 字节, 目标: ${mapping.remoteHost}:${mapping.remotePort}`);
            }
          });
        }
      });

      // 处理客户端断开
      socket.on('close', () => {
        logger.info(`客户端断开连接: ${clientInfo.address} (ID: ${clientId})`);

        if (clientsByPort.has(mapping.localPort)) {
          clientsByPort.get(mapping.localPort).delete(clientId);
        }

        // 发送断开连接消息
        if (serialPort.isOpen) {
          const packet = createPacket(CMD_DISCONNECT, clientId, '', mapping.remoteHost, mapping.remotePort);
          serialPort.write(packet, (err) => {
            if (err) {
              logger.error('串口写入失败:', err.message);
            } else {
              logger.debug(`发送断开连接消息: ${clientId}`);
            }
          });
        }
      });

      socket.on('error', (err) => {
        logger.error(`客户端错误 ${clientInfo.address}:`, err.message);
      });
    });

    // 监听端口
    server.listen(mapping.localPort, () => {
      logger.info(`TCP服务器正在监听端口 ${mapping.localPort} -> ${mapping.remoteHost}:${mapping.remotePort} (${mapping.description})`);
    });

    server.on('error', (err) => {
      logger.error(`TCP服务器错误 (端口 ${mapping.localPort}):`, err.message);
    });

    servers.push(server);
  });
}

// 优雅关闭函数
async function gracefulShutdown() {
  logger.info('\n正在优雅关闭服务器...');
  
  try {
    // 1. 首先发送断开连接消息给所有客户端
    if (serialPort && serialPort.isOpen) {
      const disconnectPromises = [];
      
      clientsByPort.forEach((clients, port) => {
        clients.forEach((clientInfo, clientId) => {
          disconnectPromises.push(
            new Promise((resolve) => {
              const packet = createPacket(CMD_DISCONNECT, clientId, '', clientInfo.mapping.remoteHost, clientInfo.mapping.remotePort);
              serialPort.write(packet, (err) => {
                if (err) {
                  logger.error(`发送断开连接消息失败 ${clientId}:`, err.message);
                } else {
                  logger.debug(`发送断开连接消息 ${clientId}`);
                }
                resolve();
              });
            })
          );
        });
      });
      
      if (disconnectPromises.length > 0) {
        logger.info(`正在发送 ${disconnectPromises.length} 个断开连接消息...`);
        await Promise.all(disconnectPromises);
        logger.info('所有断开连接消息已发送');
      }
    }

    // 2. 关闭所有客户端连接
    const clientClosePromises = [];
    
    clientsByPort.forEach((clients, port) => {
      clients.forEach((clientInfo, clientId) => {
        if (clientInfo.socket && !clientInfo.socket.destroyed) {
          clientClosePromises.push(
            new Promise((resolve) => {
              const timeout = setTimeout(() => {
                if (!clientInfo.socket.destroyed) {
                  logger.warn(`强制关闭客户端连接: ${clientInfo.address} (ID: ${clientId})`);
                  clientInfo.socket.destroy();
                }
                resolve();
              }, 3000); // 3秒超时
              
              clientInfo.socket.once('close', () => {
                clearTimeout(timeout);
                logger.info(`客户端连接已关闭: ${clientInfo.address} (ID: ${clientId})`);
                resolve();
              });
              
              clientInfo.socket.end();
            })
          );
        }
      });
    });
    
    if (clientClosePromises.length > 0) {
      logger.info(`正在关闭 ${clientClosePromises.length} 个客户端连接...`);
      await Promise.all(clientClosePromises);
      logger.info('所有客户端连接已关闭');
    }

    // 3. 清理客户端映射
    clientsByPort.clear();

    // 4. 关闭所有TCP服务器
    const serverClosePromises = servers.map(server => {
      return new Promise((resolve) => {
        const serverPort = server.address()?.port || 'unknown';
        
        const timeout = setTimeout(() => {
          logger.warn(`强制关闭TCP服务器 (端口 ${serverPort})`);
          resolve();
        }, 5000); // 5秒超时
        
        server.close(() => {
          clearTimeout(timeout);
          logger.info(`TCP服务器已关闭 (端口 ${serverPort})`);
          resolve();
        });
      });
    });
    
    if (serverClosePromises.length > 0) {
      logger.info(`正在关闭 ${serverClosePromises.length} 个TCP服务器...`);
      await Promise.all(serverClosePromises);
      logger.info('所有TCP服务器已关闭');
    }

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

    logger.info('服务器已优雅关闭');
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

logger.info('TCP Bridge Server 已启动');
logger.info('使用方法:');
logger.info('  node tcp-server.js [串口] [波特率] [硬件流控] [映射配置文件]');
logger.info('  例如: node tcp-server.js COM20 115200 true port-mapping.json');
logger.info('');
logger.info('参数说明:');
logger.info(`  串口: ${SERIAL_PORT}`);
logger.info(`  波特率: ${BAUD_RATE}`);
logger.info(`  硬件流控: ${FLOW_CONTROL}`);
logger.info(`  映射配置: ${MAPPING_FILE}`);
logger.info('');
logger.info('日志级别配置:');
logger.info('  QUIET=true    - 静默模式，只显示错误和警告');
logger.info('  DEBUG=true    - 调试模式，显示详细信息');
logger.info('  VERBOSE=true  - 详细模式，显示所有操作');
logger.info('');
logger.info('按 Ctrl+C 退出');

// 启动程序
loadPortMappings();
createMultiPortServers();
