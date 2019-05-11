'use strict';

const dgram = require('dgram');

console.log('reached the tracker');
//parsing the decoded bencode into hostname, port, etc
const urlParse = require ('url').parse;

// sending through a socket requires a buffer
const buffer = require('buffer').Buffer;

const crypto = require('crypto');

var getPeers = (torrent, callback) => {
    console.log('called getPeers');
    const url = urlParse(torrent.announce.toString('utf8'));
    const socket = dgram.createSocket('udp4'); 
    
    udpSend(socket, buildConnReq(), url);

    console.log('about to turn on socket');

    // create a socket on turn on
    socket.on('message', response => {
        console.log('socket connections');
        if (rType(response) === 'connect') {
            const connResp = parseConnResp(response);
            const announceReq = buildAnnounceReq(connResp.connection_id, torrent);
            
            udpSend(socket, announceReq, url);
        } else if (rType(response) === 'announce') {
            const announceResp = parseAnnounceResp(response);
            // 5. pass peers to callback
            callback(announceResp.peers);
        }
    });
}

function udpSend(socket, message, rawUrl, callback) {
    const url = urlParse(rawUrl);
    socket.send(message, 0, message.length, url.port, url.hostname, callback);
}

function rType(resp) {
    const action = resp.readUInt32BE(0);
    if (action === 0) return 'connect';
    if (action === 1) return 'announce';

}

function buildConnReq() {
    var buf = Buffer.allocUnsafe(16);
    buf.writeUInt32BE(0x417, 0);
    buf.writeUInt32BE(0x27101980, 4);
    // action
    buf.writeUInt32BE(0, 8); // 4
    // transaction id
    crypto.randomBytes(4).copy(buf, 12);
    
    return buf;
}

function parseConnResp(resp) {
    var obj = {
        action: resp.readUInt32BE(0),
        transaction_id: resp.readUInt32BE(4),
        connection_id: resp.slice(8)
    }
    return obj;
}

function buildAnnounceReq(connId, torrent, port=6885) {
    const buf = Buffer.allocUnsafe(98);

    connId.copy(buf,0);
    buf.writeUInt32BE(1,8);
    (crypto.randomBytes(4)).copy(buf,12);

    const torrentParser = require('./torrent-parser.js');

    torrentParser.infoHash(torrent).copy(buf,16);

    const util = require('./util.js');
    
    util.getId().copy(buf,36);

    // downloaded
    Buffer.alloc(8).copy(buf,56);
    // left
    torrentParser.size(torrent).copy(buf,64);
    // uploaded
    Buffer.alloc(8).copy(buf,72);
    
    buf.writeUInt32BE(0, 80);

    buf.writeUInt32BE(0, 84);

    (crypto.randomBytes(4)).copy(buf,88);

    buf.writeInt32BE(-1,92);

    buf.writeUInt16BE(port,96);

    return buf;
}


function group(iterable, groupSize) {
    let groups = [];
    for (let i = 0; i < iterable.length; i += groupSize) {
        groups.push(iterable.slice(i, i + groupSize));
    }
    return groups;
}

function parseAnnounceResp(resp) {
    var obj = {
        action: resp.readUInt32BE(0),
        transactionId: resp.readUInt32BE(4),
        leechers: resp.readUInt32BE(8),
        seeders: resp.readUInt32BE(12),
        peers: group(resp.slice(20), 6).map(address => {
            return {
                ip: address.slice(0, 4).join('.'),
                port: address.readUInt16BE(4)
            }
        })
    }
    return obj;
}

module.exports.getPeers = getPeers;
