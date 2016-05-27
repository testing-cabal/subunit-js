// Copyright 2016 Hewlett-Packard Development Company, L.P.
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may
// not use this file except in compliance with the License. You may obtain
// a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
// License for the specific language governing permissions and limitations
// under the License.
'use strict';

var stream = require('stream');
var util = require('util');

var crc32 = require('buffer-crc32');
var BufferList = require('bl');

var signature = 0xB3;
var statusFlags = {
  0x0: null,
  0x1: 'exists',
  0x2: 'inprogress',
  0x3: 'success',
  0x4: 'uxsuccess',
  0x5: 'skip',
  0x6: 'fail',
  0x7: 'xfail'
};

var flagMasks = {
  testId: 0x0800,
  routeCode: 0x0400,
  timestamp: 0x0200,
  runnable: 0x0100,
  tags: 0x0080,
  mimeType: 0x0020,
  eof: 0x0010,
  fileContent: 0x0040
};

function readVarInt(buf, index) {
  buf = buf.slice(index, index + 4);

  var first = buf.readUInt8(0);
  var type = first & 0xC0;  // get first 2 bits for prefix
  var value = first & 0x3F; // last 6 bits for first octet

  if (type === 0x00) { // 00, 1 octet
    return { length: 1, value: value };
  } else if (type === 0x40) { // 01, 2 octets
    return { length: 2, value: (value << 8) | buf.readUIntBE(1, 1) };
  } else if (type === 0x80) { // 10, 3 octets
    return { length: 3, value: (value << 16) | buf.readUIntBE(1, 2) };
  } else { // 11, 4 octets
    return { length: 4, value: (value << 24) | buf.readUIntBE(1, 3) };
  }
}

function writeVarInt(value) {
  if (value < 0) {
    throw new Error('Value must be greater than zero: ' + value.toString());
  }

  var ret;
  if (value < 64) {
    ret = new Buffer(1);
    ret.writeUIntBE(value, 0, 1);
  } else if (value < 16384) {
    ret = new Buffer(2);
    ret.writeUIntBE((value | 0x4000) >>> 0, 0, 2);
  } else if (value < 4194304) {
    ret = new Buffer(3);
    ret.writeUIntBE((value | 0x800000) >>> 0, 0, 3);
  } else if (value < 1073741824) {
    ret = new Buffer(4);
    ret.writeUIntBE((value | 0xC0000000) >>> 0, 0, 4);
  } else {
    throw new Error('Value is too large to encode: ' + value.toString());
  }

  return ret;
}

function readUtf8(buf, index) {
  var len = readVarInt(buf, index);
  var value = buf.slice(index + len.length, index + len.length + len.value);

  return {
    length: len.length + len.value,
    value: value.toString('utf8')
  };
}

function writeUtf8(str) {
  var strLen = Buffer.byteLength(str, 'utf8');
  var num = writeVarInt(strLen);

  var ret = new Buffer(num.length + strLen);
  num.copy(ret, 0);
  ret.write(str, num.length, strLen, 'utf8');

  return ret;
}

function SubunitToObjectStream(options) {
  if (!(this instanceof SubunitToObjectStream)) {
    return new SubunitToObjectStream(options);
  }

  this.bl = new BufferList();

  this.offset = 0;
  this.midCharacter = false;

  stream.Transform.call(this, {
    objectMode: true
  });
}
util.inherits(SubunitToObjectStream, stream.Transform);

SubunitToObjectStream.prototype._transform = function(chunk, enc, cb) {
  this.bl.append(chunk);

  try {
    while (this.offset < this.bl.length) {
      var sig = this.bl.readUInt8(this.offset);
      var flags = this.bl.readUInt16BE(this.offset + 1);
      var packetLength = readVarInt(this.bl, this.offset + 3);
      if (sig !== signature) {
        this.emit('error', 'Bad packet at offset ' + this.offset.toString());
      }

      var ret = {
        status: statusFlags[flags & 0x0007]
      };

      var packet = {
        length: packetLength.value,
        flags: {}
      };

      for (var flag in flagMasks) {
        packet.flags[flag] = (flags & flagMasks[flag]) !== 0;
      }

      var optionalsOffset = this.offset + 3 + packetLength.length;

      if (packet.flags.timestamp) {
        var timestamp = {};
        var seconds = this.bl.readUInt32BE(optionalsOffset);
        optionalsOffset += 4;

        var nanos = readVarInt(this.bl, optionalsOffset);
        optionalsOffset += nanos.length;

        ret.timestamp = new Date((seconds * 1000) + (nanos.value / 1000000));
      }

      if (packet.flags.testId) {
        var testId = readUtf8(this.bl, optionalsOffset);
        ret.testId = testId.value;
        optionalsOffset += testId.length;
      }

      if (packet.flags.tags) {
        var count = readVarInt(this.bl, optionalsOffset);
        optionalsOffset += count.length;

        var tags = [];
        for (var i = 0; i < count.value; i++) {
          var tag = readUtf8(this.bl, optionalsOffset);
          optionalsOffset += tag.length;

          tags.push(tag.value);
        }
        ret.tags = tags;
      }

      if (packet.flags.mimeType) {
        var mime = readUtf8(this.bl, optionalsOffset);
        optionalsOffset += mime.length;
        ret.mimeType = mime.value;
      }

      if (packet.flags.fileContent) {
        var name = readUtf8(this.bl, optionalsOffset);
        optionalsOffset += name.length;
        ret.fileName = name.value;

        var fileLength = readVarInt(this.bl, optionalsOffset);
        optionalsOffset += fileLength.length;
        ret.fileContent = this.bl.slice(
            optionalsOffset, optionalsOffset + fileLength.value);
        optionalsOffset += fileLength.value;
      }

      if (packet.flags.routeCode) {
        var route = readUtf8(this.bl, optionalsOffset);
        optionalsOffset += route.length;
        ret.routeCode = route.value;
      }

      // ignore CRC

      ret._packet = packet;
      this.push(ret);
      this.offset += packetLength.value;
    }
  } catch (e) {
    if (e instanceof RangeError) {
      // ignore and wait for the next packet to try again
    } else {
      throw e;
    }
  }

  cb();
};

function ObjectToSubunitStream(options) {
  if (!(this instanceof ObjectToSubunitStream)) {
    return new ObjectToSubunitStream(options);
  }

  this.bl = new BufferList();

  stream.Transform.call(this, {
    objectMode: true
  });
}
util.inherits(ObjectToSubunitStream, stream.Transform);

ObjectToSubunitStream.prototype._transform = function(chunk, encoding, next) {
  //console.log('chunk', chunk)
  // signature (1) + flags (2) + length (varint) + body
  var flags = 0x2000; // version 0x2

  var statusFlag = Object.keys(statusFlags).find(function(flag) {
    return statusFlags[flag] === chunk.status;
  });
  flags |= statusFlag;

  var _packet = chunk._packet;
  if (typeof _packet !== 'undefined' && typeof _packet.flags !== 'undefined') {
    if (_packet.flags.runnable) {
      flags |= flagMasks.runnable;
    }

    if (_packet.flags.eof) {
      flags |= flagMasks.eof;
    }
  }

  var body = [];
  if (typeof chunk.timestamp !== 'undefined') {
    flags |= flagMasks.timestamp;

    var millis = chunk.timestamp.getTime();
    var seconds = Math.floor(millis / 1000);
    var nanos = (millis - (seconds * 1000)) * 1000000;

    var varNanos = writeVarInt(nanos);
    var buf = new Buffer(4 + varNanos.length);
    buf.writeUInt32BE(seconds, 0);
    varNanos.copy(buf, 4);
    body.push(buf);
  }

  if (typeof chunk.testId !== 'undefined') {
    flags |= flagMasks.testId;
    body.push(writeUtf8(chunk.testId));
  }

  if (typeof chunk.tags !== 'undefined') {
    flags |= flagMasks.tags;

    body.push(writeVarInt(chunk.tags.length));
    chunk.tags.forEach(function(tag) {
      body.push(writeUtf8(tag));
    });
  }

  if (typeof chunk.mimeType !== 'undefined') {
    flags |= flagMasks.mimeType;
    body.push(writeUtf8(chunk.mimeType));
  }

  if (typeof chunk.fileName !== 'undefined' &&
      typeof chunk.fileContent !== 'undefined') {
    flags |= flagMasks.fileContent;

    body.push(writeUtf8(chunk.fileName));
    body.push(writeVarInt(chunk.fileContent.length));
    body.push(chunk.fileContent);
  }

  if (typeof chunk.routeCode !== 'undefined') {
    flags |= flagMasks.routeCode;
    body.push(writeUtf8(chunk.routeCode));
  }

  var bodyBuf = Buffer.concat(body);

  // baseLength = header (minus varint length) + body + crc32
  var baseLength = 3 + bodyBuf.length + 4;

  // length of length depends on baseLength and its own length (varint)
  var lengthLength;
  if (baseLength <= 62) { // 63 - 1
    lengthLength = 1;
  } else if (baseLength <= 16381) { // 16383 - 2
    lengthLength = 2;
  } else if (baseLength <= 4194300) { // 4194303 - 3
    lengthLength = 3;
  } else {
    throw new Error('Length too long: ' + baseLength);
  }

  var header = new Buffer(3);
  header.writeUInt8(signature);
  header.writeUInt16BE(flags, 1);

  var length = writeVarInt(baseLength + lengthLength);
  var partial = Buffer.concat([header, length, bodyBuf]);
  var crc = crc32(partial);

  this.push(Buffer.concat([partial, crc]));
  next();
};

module.exports = {
  SubunitToObjectStream: SubunitToObjectStream,
  ObjectToSubunitStream: ObjectToSubunitStream
};
