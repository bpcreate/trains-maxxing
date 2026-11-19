// Receives live inputs (iPad kaleidoscope, phone cameras) over WebRTC and
// exposes each one as a <video> element the layers can show.

export class LiveInputs {
  constructor(net) {
    this.net = net;
    this.peers = new Map();  // live id -> RTCPeerConnection
    this.videos = new Map(); // live id -> <video>
    net.on('rtc', (m) => this._onSignal(m.from, m.d));
    net.on('rtc.gone', (m) => this._drop(m.id));
    net.on('status', () => {
      // server connection was lost: ids are reassigned, so start clean
      if (!net.connected) for (const id of [...this.peers.keys()]) this._drop(id);
    });
  }

  _drop(id) {
    this.peers.get(id)?.close();
    this.peers.delete(id);
    const v = this.videos.get(id);
    if (v) v.srcObject = null;
    this.videos.delete(id);
  }

  async _onSignal(from, d) {
    if (!d) return;
    try {
      if (d.sdp?.type === 'offer') {
        this._drop(from);
        // local network only: no STUN/TURN servers, so it works without internet
        const pc = new RTCPeerConnection({ iceServers: [] });
        this.peers.set(from, pc);
        pc.onicecandidate = (e) => {
          if (e.candidate) this.net.send({ t: 'rtc', to: from, d: { ice: e.candidate } });
        };
        pc.ontrack = (e) => {
          let v = this.videos.get(from);
          if (!v) {
            v = document.createElement('video');
            v.muted = true;
            v.playsInline = true;
            v.autoplay = true;
            this.videos.set(from, v);
          }
          v.srcObject = e.streams[0] || new MediaStream([e.track]);
          v.play().catch(() => {});
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' && this.peers.get(from) === pc) this._drop(from);
        };
        await pc.setRemoteDescription(d.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.net.send({ t: 'rtc', to: from, d: { sdp: pc.localDescription } });
      } else if (d.ice) {
        await this.peers.get(from)?.addIceCandidate(d.ice);
      }
    } catch (e) {
      console.warn('live input handshake failed', e);
    }
  }
}
