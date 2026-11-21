// Sends the kaleidoscope canvas to every open stage over WebRTC.
// The server only relays the handshake; video goes device-to-laptop directly.

export class Streamer {
  constructor(net, canvas) {
    this.net = net;
    this.canvas = canvas;
    this.stream = null;
    this.peers = new Map(); // stage id -> RTCPeerConnection
    net.on('rtc.start', (m) => this._offer(m.stage));
    net.on('rtc', (m) => this._onSignal(m.from, m.d));
    net.on('status', () => {
      if (!net.connected) this.closeAll();
    });
  }

  get supported() {
    return typeof RTCPeerConnection !== 'undefined' && typeof this.canvas.captureStream === 'function';
  }

  closeAll() {
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
  }

  /** Any connection actually carrying video right now? */
  get live() {
    for (const pc of this.peers.values()) if (pc.connectionState === 'connected') return true;
    return false;
  }

  async _offer(stage) {
    if (!this.supported) return;
    try {
      this.stream ||= this.canvas.captureStream(30);
      this.peers.get(stage)?.close();
      const pc = new RTCPeerConnection({ iceServers: this.net.info.ice || [] }); // none on the local network, so it works without internet
      this.peers.set(stage, pc);
      for (const track of this.stream.getVideoTracks()) {
        track.contentHint = 'motion';
        const sender = pc.addTrack(track, this.stream);
        try {
          const params = sender.getParameters();
          params.encodings = params.encodings?.length ? params.encodings : [{}];
          params.encodings[0].maxBitrate = 5_000_000;
          params.degradationPreference = 'maintain-framerate';
          await sender.setParameters(params);
        } catch { /* browser picks its own bitrate */ }
      }
      pc.onicecandidate = (e) => {
        if (e.candidate) this.net.send({ t: 'rtc', to: stage, d: { ice: e.candidate } });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' && this.peers.get(stage) === pc) {
          // try again shortly, e.g. after a Wi-Fi blip
          setTimeout(() => this.peers.get(stage) === pc && this._offer(stage), 2000);
        }
      };
      await pc.setLocalDescription(await pc.createOffer());
      this.net.send({ t: 'rtc', to: stage, d: { sdp: pc.localDescription } });
    } catch (e) {
      console.warn('could not start stream', e);
    }
  }

  async _onSignal(from, d) {
    const pc = this.peers.get(from);
    if (!pc || !d) return;
    try {
      if (d.sdp) await pc.setRemoteDescription(d.sdp);
      else if (d.ice) await pc.addIceCandidate(d.ice);
    } catch (e) {
      console.warn('stream handshake failed', e);
    }
  }
}
