const fs = require('fs');
const bencode = require('bencode');
const crypto = require('crypto');

function open(filepath) {
    var torrent = bencode.decode(fs.readFileSync(filepath));
    return torrent;
}

function size(torrent) {
    const bignum = require('bignum');
    const size = torrent.info.files ? torrent.info.files.map(file => file.length).reduce((a, b) => a + b) : torrent.info.length;

    return bignum.toBuffer(size, {size: 8});
}

function infoHash(torrent) {
    var info = bencode.encode(torrent.info);
    var hashedInfo = crypto.createHash('sha1').update(info).digest();
    return hashedInfo; 
}

module.exports.open = open;
module.exports.size = size;
module.exports.infoHash = infoHash;
