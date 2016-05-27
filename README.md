node-subunit
============

Provides utilities for reading and writing
[Subunit streams](https://github.com/testing-cabal/subunit) with Node.js,
targeting Node versions 0.10 (pre-packaged on Ubuntu Trusty) and higher.

Installation
------------

    npm install --save node-subunit

Usage
-----
### Native Packet Format
Subunit packets are represented in JavaScript like so:
```javascript
{
    timestamp: <Date>,
    testId: <string>,
    tags: <string[]>,
    mime: <string>,
    fileContent: <Buffer>,
    fileName: <string>,
    routingCode: <string>,
    status: <string>
    _packet: {
        length: <number>
        flags: {
            testId: <boolean>,
            routeCode: <boolean>,
            timestamp: <boolean>,
            runnable: <boolean>,
            tags: <boolean>,
            mimeType: <boolean,
            eof: <boolean>,
            fileContent: <boolean>
        }
    }
}
```

Note that `true` entries in `_packet.flags` generally imply an associated field
of the same name, except for `runnable` and `eof`. All fields (except `_packet`)
are optional and, when read, will be undefined if not included in the original
bytes. The `status` field is a bit special in that it

### Reading with `SubunitToObjectStream`
`SubunitToObjectStream` is a transform stream that accepts Subunit bytes and
outputs objects as described above. To read a file `testrepository.subunit`:

```javascript
var fs = require('fs');
var subunit = require('node-subunit');

fs.createReadStream('testrepository.subunit')
    .pipe(new subunit.SubunitToObjectStream())
    .on('data', function(packet) {
      console.log(packet);
    });
```

### Writing with `ObjectToSubunitStream`
The `ObjectToSubunitStream` is also a transform stream, but it accepts objects
as formatted above and outputs Subunit-compatible bytes.

A few notes:
* Flag masks for the `status` field will be looked up automatically based on its
  string value (e.g. `success`, `skip`, `fail`, etc)
* Values in `_packet` are ignored, except for `flags.runnable` and `flags.eof`.
  These flag masks will automatically be added based on the defined values in
  the packet object.

As an example, this code:
```javascript
var fs = require('fs');
var subunit = require('./index.js');

var stream = subunit.ObjectToSubunitStream();
stream.pipe(fs.createWriteStream('./test1.subunit'));
stream.write({
  testId: 'TestyMcTestface',
  status: 'success',
  timestamp: new Date(),
  _packet: {
    flags: { runnable: true }
  }
});
```

... is equivalent to this (save for timestamps and thus the CRC):
```bash
subunit-output --success TestyMcTestface
```

### Chaining
The streams are mostly idempotent, so they can be chained together (and perhaps
mutated along the way). However, note the following:

```javascript
fs.createReadStream('testrepository.subunit')
    .pipe(new subunit.SubunitToObjectStream())
    .on('data', function(d) {
      console.log('<-', d.timestamp);
    })
    .pipe(new subunit.ObjectToSubunitStream())
    .pipe(new subunit.SubunitToObjectStream())
    .on('data', function(d) {
        console.log('->', d.timestamp);
    });
```

If you run this code, you might notice timestamps change (though the result
should otherwise be bit-identical). Since JavaScript `Date` values don't have
nanosecond resolution, timestamp values will be rounded down to the nearest
millisecond when read initially. This generally isn't noticeable, but may lead
to some unexpected trouble in some situations.
