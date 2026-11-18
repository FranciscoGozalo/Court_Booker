'use strict';
// Wakes your PC from sleep over the internet with a "magic packet": six 0xFF bytes, then the
// PC's network card address (WAKE_MAC) sixteen times, sent by UDP to your home's public address
// on WAKE_PORT. Your router passes that port on to the PC (a port forward), and the sleeping
// network card wakes the PC when it sees its own address in the packet. Nothing on the PC
// listens on that port; the packet carries no command and no data, only the card's address.
//
// The home address is the one your PC's pings last came from (Railway's X-Real-IP header).

const dgram = require('dgram');
const net = require('net');

// "44:af:28:7a:1a:5c", "44-AF-28-7A-1A-5C" or "44af287a1a5c" -> "44af287a1a5c". Anything else: null.
function readMac(text) {
  const t = String(text || '').trim();
  if (!/^[0-9a-f]{2}([:-]?)[0-9a-f]{2}(\1[0-9a-f]{2}){4}$/i.test(t)) return null;
  return t.replace(/[:-]/g, '').toLowerCase();
}

function magicPacket(mac) {
  const card = Buffer.from(mac, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(card)]);
}

// A public IPv4 address, or null. Private, local and reserved ranges cannot be reached from
// Railway, and 100.64/10 means the internet provider shares one address (no port forward possible).
function publicIPv4(text) {
  const ip = String(text || '').trim();
  if (!net.isIPv4(ip)) return null;
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return null;
  if (a === 169 && b === 254) return null;
  if (a === 172 && b >= 16 && b <= 31) return null;
  if (a === 192 && b === 168) return null;
  if (a === 100 && b >= 64 && b <= 127) return null;
  return ip;
}

// Sends the packet a few times (UDP can drop one). Resolves with how many went.
function sendWake({ host, port, mac }, { createSocket = dgram.createSocket, times = 3, gapMs = 200 } = {}) {
  return new Promise((resolve, reject) => {
    const packet = magicPacket(mac);
    const sock = createSocket('udp4');
    let sent = 0, done = false;
    const finish = err => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      if (err) reject(err); else resolve(sent);
    };
    sock.on('error', finish);
    const one = () => sock.send(packet, port, host, err => {
      if (err) return finish(err);
      if (++sent >= times) return finish(null);
      setTimeout(one, gapMs);
    });
    one();
  });
}

module.exports = { readMac, magicPacket, publicIPv4, sendWake };
