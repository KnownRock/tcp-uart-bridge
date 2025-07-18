const fs = require('fs');
const path = require('path');

// 日志级别定义
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

// 日志级别名称
const LEVEL_NAMES = {
    0: 'DEBUG',
    1: 'INFO',
    2: 'WARN',
    3: 'ERROR'
};

// 日志级别颜色（用于控制台输出）
const LEVEL_COLORS = {
    DEBUG: '\x1b[36m',    // 青色
    INFO: '\x1b[32m',     // 绿色
    WARN: '\x1b[33m',     // 黄色
    ERROR: '\x1b[31m'     // 红色
};

const RESET_COLOR = '\x1b[0m';

class Logger {
    constructor(prefix = '', options = {}) {
        this.prefix = prefix;
        this.options = {
            debug: options.debug || false,
            info: options.info !== false,  // 默认启用
            warn: options.warn !== false,  // 默认启用
            error: options.error !== false, // 默认启用
            verbose: options.verbose || false,
            timestamp: options.timestamp !== false, // 默认启用时间戳
            colorize: options.colorize !== false,   // 默认启用颜色
            logToFile: options.logToFile || false,
            logFile: options.logFile || 'tcp-bridge.log'
        };
        
        // 确保日志目录存在
        if (this.options.logToFile) {
            const logDir = path.dirname(path.resolve(this.options.logFile));
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
        }
    }

    // 格式化时间戳
    formatTimestamp() {
        const now = new Date();
        return now.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    }

    // 格式化日志消息
    formatMessage(level, message, data) {
        const timestamp = this.options.timestamp ? `[${this.formatTimestamp()}] ` : '';
        const prefix = this.prefix ? `[${this.prefix}] ` : '';
        const levelName = `[${LEVEL_NAMES[level]}] `;
        
        let formattedMessage = `${timestamp}${prefix}${levelName}${message}`;
        
        // 如果有额外数据，添加到消息中
        if (data !== undefined) {
            if (typeof data === 'object') {
                formattedMessage += ' ' + JSON.stringify(data, null, 2);
            } else {
                formattedMessage += ' ' + String(data);
            }
        }
        
        return formattedMessage;
    }

    // 输出日志到控制台
    outputToConsole(level, message) {
        const levelName = LEVEL_NAMES[level];
        
        if (this.options.colorize) {
            const colorCode = LEVEL_COLORS[levelName] || '';
            console.log(colorCode + message + RESET_COLOR);
        } else {
            console.log(message);
        }
    }

    // 输出日志到文件
    outputToFile(message) {
        if (this.options.logToFile) {
            try {
                fs.appendFileSync(this.options.logFile, message + '\n');
            } catch (err) {
                console.error('写入日志文件失败:', err.message);
            }
        }
    }

    // 通用日志方法
    log(level, message, data) {
        const formattedMessage = this.formatMessage(level, message, data);
        
        // 输出到控制台（根据配置）
        switch (level) {
            case LOG_LEVELS.DEBUG:
                if (this.options.debug || this.options.verbose) {
                    this.outputToConsole(level, formattedMessage);
                }
                break;
            case LOG_LEVELS.INFO:
                if (this.options.info) {
                    this.outputToConsole(level, formattedMessage);
                }
                break;
            case LOG_LEVELS.WARN:
                if (this.options.warn) {
                    this.outputToConsole(level, formattedMessage);
                }
                break;
            case LOG_LEVELS.ERROR:
                if (this.options.error) {
                    this.outputToConsole(level, formattedMessage);
                }
                break;
        }
        
        // 输出到文件（如果启用）
        this.outputToFile(formattedMessage);
    }

    // 便捷方法
    debug(message, data) {
        this.log(LOG_LEVELS.DEBUG, message, data);
    }

    info(message, data) {
        this.log(LOG_LEVELS.INFO, message, data);
    }

    warn(message, data) {
        this.log(LOG_LEVELS.WARN, message, data);
    }

    error(message, data) {
        this.log(LOG_LEVELS.ERROR, message, data);
    }

    // 详细模式（等同于debug）
    verbose(message, data) {
        if (this.options.verbose) {
            this.log(LOG_LEVELS.DEBUG, message, data);
        }
    }

    // 创建子日志记录器
    child(prefix, options = {}) {
        const childPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
        const childOptions = { ...this.options, ...options };
        return new Logger(childPrefix, childOptions);
    }

    // 更新配置
    setOptions(options) {
        this.options = { ...this.options, ...options };
    }

    // 启用/禁用特定级别
    enable(level) {
        if (typeof level === 'string') {
            this.options[level.toLowerCase()] = true;
        }
    }

    disable(level) {
        if (typeof level === 'string') {
            this.options[level.toLowerCase()] = false;
        }
    }
}

// 工厂方法
function createLogger(prefix = '', options = {}) {
    return new Logger(prefix, options);
}

// 从环境变量创建日志记录器
function createFromEnv(prefix = '', additionalOptions = {}) {
    const options = {
        debug: process.env.DEBUG === 'true',
        info: process.env.QUIET !== 'true',
        warn: true,
        error: true,
        verbose: process.env.VERBOSE === 'true',
        logToFile: process.env.LOG_TO_FILE === 'true',
        logFile: process.env.LOG_FILE || 'tcp-bridge.log',
        ...additionalOptions
    };
    
    return new Logger(prefix, options);
}

// 导出
module.exports = {
    Logger,
    LOG_LEVELS,
    create: createLogger,
    createFromEnv,
    
    // 便捷方法（使用默认实例）
    debug: (message, data) => {
        const logger = createFromEnv();
        logger.debug(message, data);
    },
    
    info: (message, data) => {
        const logger = createFromEnv();
        logger.info(message, data);
    },
    
    warn: (message, data) => {
        const logger = createFromEnv();
        logger.warn(message, data);
    },
    
    error: (message, data) => {
        const logger = createFromEnv();
        logger.error(message, data);
    }
};
