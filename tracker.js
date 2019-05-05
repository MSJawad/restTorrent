const dgram = require('dgram');

//parsing the decoded bencode into hostname, port, etc
const urlParse = require ('url').parse;

// sending through a socket requires a buffer
const buffer = require('buffer').Buffer;

var getPeers = (torrent, callback) => {
    const url = urlParse(torrent.announce.toString('utf8'));
    
    const socket = dgram.createSocket('udp4');
    
    const newMsg = buffer.from('hello', 'utf8');
    
    socket.send(newMsg, 0, newMsg.length, url.port, url.host, () => {});
    
    // create a socket on turn on
    socket.on('message', response => {
        if (rType(response) === 'connect') {
            const connResp = parseConnResp(response);
            const announceReq = buildAnounceReq(connResp.connectionId);
            
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
  socket.send(message, 0, message.length, url.port, url.host, callback);
}

function respType(resp) {
  // ...
}

function buildConnReq() {
  // ...
}

function parseConnResp(resp) {
  // ...
}

function buildAnnounceReq(connId) {
  // ...
}

function parseAnnounceResp(resp) {
  // ...
}

module.exports.getPeers = getPeers;
