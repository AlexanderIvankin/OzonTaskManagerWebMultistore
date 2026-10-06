const fs = require('fs');
const path = require('path');

class Logger {
  constructor(logPath) {
    this.logPath = logPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    this.stream = fs.createWriteStream(logPath, { flags: 'a' });
  }
  _write(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
    this.stream.write(line + '\n');
  }
  info(msg)  { this._write('INFO',  msg); }
  warn(msg)  { this._write('WARN',  msg); }
  error(msg) { this._write('ERROR', msg); }
  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

module.exports = Logger;