# TCP-UART Bridge

[中文文档](./README_CN.md) | English

A Node.js-based TCP-UART bridge application that enables multi-port mapping through serial port communication. This tool allows you to tunnel TCP connections through UART interfaces, making it ideal for IoT devices, embedded systems, and remote network access scenarios.

## Features

- **Multi-port mapping**: Configure multiple local ports to map to different remote hosts and ports
- **Binary protocol**: Optimized binary packet format for efficient serial communication
- **Client management**: Advanced client session management with UUID-based identification
- **Flexible configuration**: JSON-based port mapping configuration
- **Comprehensive logging**: Multi-level logging system with file output support
- **Flow control**: Configurable UART flow control settings
- **Error handling**: Robust error handling and connection recovery

## Installation

1. Clone the repository:
```bash
git clone https://github.com/knownrock/tcp-uart-bridge.git
cd tcp-uart-bridge
```

2. Install dependencies:
```bash
npm install
```

## Configuration

### Port Mapping Configuration

Edit `port-mapping.json` to configure your port mappings:

```json
{
  "portMappings": [
    {
      "localPort": 8080,
      "remoteHost": "localhost",
      "remotePort": 22,
      "description": "SSH forwarding to local port 22"
    },
    {
      "localPort": 8081,
      "remoteHost": "localhost",
      "remotePort": 80,
      "description": "HTTP forwarding to local port 80"
    }
  ]
}
```

### Environment Variables

- `DEBUG=true`: Enable debug logging
- `QUIET=true`: Disable info logging
- `VERBOSE=true`: Enable verbose logging

## Usage

### TCP Server Mode

Run the TCP server that listens for incoming connections and forwards them through UART:

```bash
npm run server
# or
node tcp-server.js [SERIAL_PORT] [BAUD_RATE] [FLOW_CONTROL] [MAPPING_FILE]
```

Parameters:
- `SERIAL_PORT`: Serial port name (default: COM1)
- `BAUD_RATE`: Baud rate (default: 115200)
- `FLOW_CONTROL`: Enable flow control (default: true)
- `MAPPING_FILE`: Port mapping configuration file (default: port-mapping.json)

Example:
```bash
node tcp-server.js COM3 115200 true port-mapping.json
```

### TCP Client Mode

Run the TCP client that receives data from UART and forwards to target hosts:

```bash
npm run client
# or
node tcp-client.js [SERIAL_PORT] [BAUD_RATE] [FLOW_CONTROL]
```

Example:
```bash
node tcp-client.js COM3 115200 true
```

### Available Scripts

- `npm run server`: Start the TCP server
- `npm run client`: Start the TCP client
- `npm run test`: Run test client
- `npm run check-ports`: Check available serial ports
- `npm run test-http`: Start HTTP test server

## Protocol Specification

The application uses an optimized binary protocol for serial communication:

```
Packet Format:
+--------+----------+----------+----------+-----------+----------+
|  CMD   | ClientID | TargetIP | TargetPort| DataLength|   Data   |
| (1B)   |  (16B)   |  (4B)    |   (2B)   |   (4B)    | (Variable)|
+--------+----------+----------+----------+-----------+----------+
```

### Command Types

- `0x01`: Data transmission
- `0x03`: Disconnect client
- `0x05`: Program close

## Architecture

### Server Side (tcp-server.js)
- Listens on configured local ports
- Accepts TCP connections from clients
- Forwards data through UART to the client side
- Manages multiple client sessions

### Client Side (tcp-client.js)
- Receives data from UART
- Establishes connections to target hosts
- Forwards responses back through UART
- Handles connection lifecycle

### Communication Flow

1. Client connects to server's local port
2. Server generates unique client ID and forwards connection data via UART
3. Client side receives data, connects to target host
4. Bidirectional data flow through UART tunnel
5. Connection cleanup on disconnect

## Logging

The application includes a comprehensive logging system:

- **Debug**: Detailed protocol and connection information
- **Info**: General operational messages
- **Warn**: Warning conditions
- **Error**: Error conditions and exceptions
- **Verbose**: Extended debugging information

Logs can be output to console and/or file based on configuration.

## Use Cases

- **IoT Device Communication**: Connect IoT devices to cloud services through UART
- **Remote System Access**: Access remote systems through serial connections
- **Network Bridging**: Bridge different network segments via serial links
- **Development and Testing**: Test network applications in isolated environments
- **Legacy System Integration**: Integrate legacy serial systems with modern TCP/IP networks

## Requirements

- Node.js >= 14.0.0
- Serial port hardware interface
- Compatible UART devices on both ends

### Recommended USB-to-Serial Module

For optimal performance and compatibility, we recommend using the **CH9111 USB-to-Serial module**:

- **Product Link**: https://item.taobao.com/item.htm?id=917091076150
- **Driver Download**: https://www.wch.cn/download/file?id=315

This module has been extensively tested and provides the best performance for high-speed data transmission. The CH9111 driver installation is required for proper functionality.

### 3D Printable Enclosure

A custom 3D printable enclosure is provided for housing the USB-to-Serial module:

- **3D Model File**: `shell.step` (STEP format)
- **Format**: ISO-10303-21 STEP file compatible with most CAD software
- **Description**: Protective enclosure designed specifically for the recommended CH9111 module

The enclosure provides physical protection and professional appearance for your TCP-UART bridge setup. You can use any 3D printer with standard PETG or ABS filament to print the case.

## Dependencies

- `serialport`: Serial port communication
- `uuid`: Unique identifier generation

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support

If you encounter any issues or have questions, please file an issue on the GitHub repository.

## Future Roadmap

The following features are planned for future releases:

### Traffic Balancing and Bandwidth Management
- **Multi-stream Bandwidth Balancing**: Implement intelligent traffic scheduling algorithms when converting multiple TCP streams to a single serial stream, preventing any single stream from consuming all available bandwidth
- **Fair Queue Scheduling**: Ensure all TCP connections receive fair transmission opportunities, avoiding TCP timeouts and retransmissions caused by bandwidth competition
- **Priority Queuing**: Support setting priorities for different TCP streams, allowing critical connections to receive higher bandwidth allocation

### Connection Management Optimization
- **Improved TCP Stream Closure Design**: Optimize connection closure procedures to ensure all buffered data is properly transmitted before closing
- **Graceful Shutdown Mechanism**: Implement more comprehensive connection closure negotiation to reduce data loss risks
- **Connection State Monitoring**: Enhanced connection state tracking with detailed connection lifecycle management

### Performance Enhancements
- **Adaptive Buffering**: Dynamically adjust buffer sizes based on network conditions
- **Compression Support**: Optional data compression functionality to improve serial port bandwidth utilization

## Changelog

### Version 2.2.0
- Improved binary protocol with optimized packet format
- Enhanced client management with UUID-based identification
- Better error handling and connection recovery
- Added comprehensive logging system
- Updated dependencies to latest versions