// uploader.js

const BACKEND_BASE = "http://127.0.0.1:8000"; // 你的 FastAPI 后端
const SEGMENT_DURATION_SEC = 10;              // 目标每片长度（秒）

const fileInput = document.getElementById("fileInput");
const startBtn  = document.getElementById("startBtn");
const logEl     = document.getElementById("log");
const videoEl   = document.getElementById("video");

let selectedFile = null;
let dashPlayer   = null;

function log(msg) {
  console.log(msg);
  logEl.textContent += msg + "\n";
}

fileInput.addEventListener("change", e => {
  selectedFile = e.target.files[0] || null;
  startBtn.disabled = !selectedFile;
  log(`选择文件: ${selectedFile ? selectedFile.name : "无"}`);
});

startBtn.addEventListener("click", async () => {
  if (!selectedFile) return;
  startBtn.disabled = true;
  try {
    const uploader = new ChunkstreamUploader(selectedFile, {
      backendBase: BACKEND_BASE,
      segmentDuration: SEGMENT_DURATION_SEC,
      maxConcurrencyHint: 3,
    });
    await uploader.start();
    const mpdUrl = uploader.getManifestUrl();
    log(`MPEG-DASH 播放地址: ${mpdUrl}`);
    playDash(mpdUrl, uploader.videoId);
  } catch (err) {
    console.error(err);
    log("上传器出错: " + err.message);
  } finally {
    startBtn.disabled = false;
  }
});

function playDash(manifestUrl, videoId) {
  if (dashPlayer) {
    dashPlayer.reset();
  }
  dashPlayer = dashjs.MediaPlayer().create();
  dashPlayer.initialize(videoEl, manifestUrl, true);

  // 用户 seek 时，通知后台优先队列
  videoEl.addEventListener("seeking", () => {
    const currentTime = videoEl.currentTime;
    const segIndex = Math.floor(currentTime / SEGMENT_DURATION_SEC);
    log(`用户 seeking 到 ${currentTime.toFixed(2)} 秒 => 优先片段 ${segIndex}`);
    fetch(`${BACKEND_BASE}/videos/${videoId}/prioritize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: segIndex })
    }).catch(err => console.warn("prioritize 出错", err));
  });
}

/**
 * ChunkstreamUploader:
 * 负责：
 * 1. 前后台协商 session（video_id、uploader_id、并发数）
 * 2. 用 MP4Box 解析 MOOV（只读头部，尽量少占内存）
 * 3. 计算虚拟片段（按时间分段）
 * 4. 向后台调度器要任务 -> 按 index 生成小 MP4/fMP4 片段 -> 上传
 * 5. 生成并上传 MPD 播放文件
 */
class ChunkstreamUploader {
  constructor(file, options) {
    this.file = file;
    this.backendBase = options.backendBase;
    this.segmentDuration = options.segmentDuration || 10;
    this.maxConcurrencyHint = options.maxConcurrencyHint || 2;

    this.videoId = null;
    this.uploaderId = null;
    this.duration = null;
    this.segmentCount = null;

    this.inFlight = new Set();
    this.stopRequested = false;

    this.byteRanges = []; // [{index, startByte, endByte, startTime, endTime}]
  }

  getManifestUrl() {
    if (!this.videoId) return null;
    return `${this.backendBase}/videos/${this.videoId}/manifest.mpd`;
  }

  async start() {
    log("== ChunkstreamUploader 启动 ==");
    // 1. 用临时 <video> 获取总时长（简单稳妥）
    this.duration = await this._getVideoDuration(this.file);
    log(`视频时长: ${this.duration.toFixed(2)} 秒`);

    this.segmentCount = Math.ceil(this.duration / this.segmentDuration);
    log(`按 ${this.segmentDuration}s 分段，共 ${this.segmentCount} 段`);

    // 2. 调后端 /videos/init 建立上传会话
    await this._initBackendSession();

    // 3. 用 MP4Box 解析 MOOV，只读头部
    const mp4Info = await this._parseMoovWithMp4box();
    log(`MP4Box 解析完成，tracks: ${mp4Info.tracks.length}`);
    // TODO: 将来用 mp4Info 的 sample table + 关键帧信息，精确计算每段的字节范围

    // 4. 计算每段的粗略字节范围（目前按字节均分做占位实现）
    this._computeByteRanges();
    log("虚拟片段字节范围计算完成（当前为均分近似实现）。");

    // 5. 生成 MPD 并上传（用 segmentCount、segmentDuration、索引规则）
    const mpdText = this._generateSimpleMPD();
    await this._uploadManifest(mpdText);
    log("MPD 上传完成，可立即播放（后台已有 manifest）。");

    // 6. 注册 uploader，与调度器协商并发能力
    await this._registerUploader();

    // 7. 启动调度循环：不断向后台要任务，并发上传相应片段
    this._scheduleLoop().catch(err => {
      console.error("scheduleLoop 出错: ", err);
      log("scheduleLoop 出错: " + err.message);
    });
  }

  // ---------- Step 1: 获取时长（用 <video> 元素） ----------

  _getVideoDuration(file) {
    return new Promise((resolve, reject) => {
      const tempVideo = document.createElement("video");
      tempVideo.preload = "metadata";
      tempVideo.onloadedmetadata = () => {
        URL.revokeObjectURL(tempVideo.src);
        resolve(tempVideo.duration);
      };
      tempVideo.onerror = () => {
        reject(new Error("无法获取视频时长"));
      };
      tempVideo.src = URL.createObjectURL(file);
    });
  }

  // ---------- Step 2: 初始化后台会话 ----------

  async _initBackendSession() {
    const resp = await fetch(`${this.backendBase}/videos/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: this.file.name,
        size: this.file.size,
        segment_count: this.segmentCount,
        segment_duration: this.segmentDuration
      })
    });
    if (!resp.ok) {
      throw new Error("初始化 /videos/init 失败");
    }
    const data = await resp.json();
    this.videoId = data.video_id;
    log(`后端 video_id: ${this.videoId}`);
  }

  // ---------- Step 3: 用 MP4Box 解析 MOOV（只读头部） ----------

  _parseMoovWithMp4box() {
    return new Promise((resolve, reject) => {
      const mp4boxFile = MP4Box.createFile();
      let infoResolved = false;
      let stoppedReading = false;

      mp4boxFile.onError = e => {
        if (!infoResolved) reject(new Error("MP4Box 解析出错: " + e));
      };

      mp4boxFile.onReady = info => {
        // 一旦解析出 moov（onReady 被调用），说明头部已就绪
        infoResolved = true;
        log("MP4Box onReady: moov 解析完成。");
        // 我们只需要头部信息，所以可以停止进一步读取文件
        stoppedReading = true;
        resolve(info);
      };

      const CHUNK_SIZE = 1024 * 1024; // 1MB 一块读取
      let offset = 0;

      const readNextChunk = () => {
        if (stoppedReading || offset >= this.file.size) {
          // 不再继续读取
          mp4boxFile.flush();
          return;
        }
        const slice = this.file.slice(offset, offset + CHUNK_SIZE);
        const reader = new FileReader();
        reader.onload = e => {
          let buffer = e.target.result;
          buffer.fileStart = offset;
          mp4boxFile.appendBuffer(buffer);
          offset += buffer.byteLength;

          if (!infoResolved) {
            // 还没解析出 moov，继续读下一块
            readNextChunk();
          } else {
            // 已经解析完成，只要 flush 一下
            mp4boxFile.flush();
          }
        };
        reader.onerror = () => {
          reject(new Error("读取 MP4 文件失败"));
        };
        reader.readAsArrayBuffer(slice);
      };

      readNextChunk();
    });
  }

  // ---------- Step 4: 计算虚拟片段的字节范围（当前粗略实现） ----------

  _computeByteRanges() {
    // ⚠️ 当前实现：简单按字节均分整文件（不严格按关键帧）
    // 将来你可以用 MP4Box 提供的 sample table + sync sample，
    // 精确计算每段对应的 byte range。
    const totalBytes = this.file.size;
    const pixels = this.segmentCount;
    const approxBytesPerSegment = Math.floor(totalBytes / pixels);

    this.byteRanges = [];
    for (let i = 0; i < this.segmentCount; i++) {
      const startTime = i * this.segmentDuration;
      const endTime = Math.min((i + 1) * this.segmentDuration, this.duration);

      const startByte = i * approxBytesPerSegment;
      const endByte = (i === this.segmentCount - 1)
        ? totalBytes
        : (i + 1) * approxBytesPerSegment;

      this.byteRanges.push({
        index: i,
        startByte,
        endByte,
        startTime,
        endTime
      });
    }
  }

  // ---------- Step 5: 生成并上传 MPD ----------

  _generateSimpleMPD() {
    // 简单生成一个静态 MPD，假设只有 video@1Mbps
    const duration = this.duration.toFixed(2);
    const timescale = 1;
    const segDur = this.segmentDuration;
    const mediaTemplate = `segment_$Number$.m4s`;

    const mpd =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" ` +
      `minBufferTime="PT2S" mediaPresentationDuration="PT${duration}S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">\n` +
      `  <Period id="1" start="PT0S">\n` +
      `    <AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">\n` +
      `      <Representation id="1" BANDWIDTH="1000000" codecs="avc1.42E01E" width="640" height="360" frameRate="25">\n` +
      `        <SegmentTemplate timescale="${timescale}" duration="${segDur}" media="${mediaTemplate}" startNumber="0" />\n` +
      `      </Representation>\n` +
      `    </AdaptationSet>\n` +
      `  </Period>\n` +
      `</MPD>\n`;

    return mpd;
  }

  async _uploadManifest(mpdText) {
    const resp = await fetch(`${this.backendBase}/videos/${this.videoId}/manifest`, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: mpdText
    });
    if (!resp.ok) {
      throw new Error("上传 MPD 失败");
    }
  }

  // ---------- Step 6: 注册 uploader ----------

  async _registerUploader() {
    const resp = await fetch(`${this.backendBase}/videos/${this.videoId}/uploaders/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_concurrency: this.maxConcurrencyHint })
    });
    if (!resp.ok) {
      throw new Error("注册 uploader 失败");
    }
    const data = await resp.json();
    this.uploaderId = data.uploader_id;
    log(`uploader_id: ${this.uploaderId}`);
  }

  // ---------- Step 7: 调度循环：向后台要任务，并发上传 ----------

  async _scheduleLoop() {
    log("开始调度循环（向后台要任务并上传片段）...");
    while (!this.stopRequested) {
      const capacity = this.maxConcurrencyHint - this.inFlight.size;
      if (capacity <= 0) {
        // 等待一会儿再检查
        await this._sleep(200);
        continue;
      }

      const tasks = await this._requestNextTasks(capacity);
      if (!tasks || tasks.length === 0) {
        // 说明可能已经全部上传完了 或 暂时没有任务，稍后再试
        await this._sleep(500);
        continue;
      }

      for (const t of tasks) {
        const idx = t.index;
        if (this.inFlight.has(idx)) continue;
        this.inFlight.add(idx);
        this._uploadOneSegment(idx)
          .catch(err => {
            console.error(`上传片段 ${idx} 出错:`, err);
            log(`上传片段 ${idx} 出错: ${err.message}`);
          })
          .finally(() => {
            this.inFlight.delete(idx);
          });
      }
    }
  }

  async _requestNextTasks(needSlots) {
    const resp = await fetch(
      `${this.backendBase}/videos/${this.videoId}/uploaders/${this.uploaderId}/next-tasks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          need_slots: needSlots,
          already_uploading: Array.from(this.inFlight)
        })
      }
    );
    if (!resp.ok) {
      throw new Error("请求 next-tasks 失败");
    }
    const data = await resp.json();
    return data.tasks || [];
  }

  // ---------- 生成一个片段并上传（内存中临时生成，上传完就扔） ----------

  async _uploadOneSegment(index) {
    const range = this.byteRanges[index];
    if (!range) {
      log(`没有 index=${index} 的 byte range，跳过`);
      return;
    }

    log(`准备上传片段 index=${index}, byte=[${range.startByte}, ${range.endByte})`);

    // 这里严格按照你的要求：不在浏览器里长期存储生成的文件，
    // 而是“现生成 -> 上传 -> 丢掉”
    // 当前占位实现：直接用原文件的 byte range 做 Blob。
    // 将来你可以在这里：
    //   1. 使用 MP4Box 根据 moov 构造一个只包含该时间段的 MP4 头
    //   2. 把原始文件中对应时间窗口的媒体数据复制到新 MP4 中
    //   3. 得到一个真正独立可播放的小 MP4 文件
    const segBlob = this.file.slice(range.startByte, range.endByte);

    const formData = new FormData();
    formData.append("segment", segBlob, `segment_${index}.m4s`);
    formData.append("index", index);
    formData.append("start_time", range.startTime);
    formData.append("end_time", range.endTime);

    const resp = await fetch(
      `${this.backendBase}/videos/${this.videoId}/segments`,
      {
        method: "POST",
        body: formData
      }
    );
    if (!resp.ok) {
      throw new Error(`上传片段 ${index} 失败`);
    }

    log(`片段 ${index} 上传完成`);
    // segBlob 变量超出作用域后，即可被 GC 回收（不在内存长期保留）
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
