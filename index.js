const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/render', async (req, res) => {
  const { image_url, audio_id, duration = 15, width = 1080, height = 1920 } = req.body;

  if (!image_url) {
    return res.status(400).json({ error: 'image_url is required' });
  }

  const tmpDir = `/tmp/${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  const imagePath = path.join(tmpDir, 'input.jpg');
  const audioPath = path.join(tmpDir, 'audio.mp3');
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    await downloadFile(image_url, imagePath);

    let ffmpegCmd;

    if (audio_id) {
      const audioUrl = `https://res.cloudinary.com/dftadswre/video/upload/${audio_id}`;
      await downloadFile(audioUrl, audioPath);
      ffmpegCmd = `ffmpeg -loop 1 -i "${imagePath}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 128k -vf "scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}" -t ${duration} -pix_fmt yuv420p -shortest "${outputPath}" -y`;
    } else {
      ffmpegCmd = `ffmpeg -loop 1 -i "${imagePath}" -c:v libx264 -tune stillimage -vf "scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}" -t ${duration} -pix_fmt yuv420p "${outputPath}" -y`;
    }

    execSync(ffmpegCmd, { timeout: 120000 });

    const videoBuffer = fs.readFileSync(outputPath);
    const base64Video = videoBuffer.toString('base64');

    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({ success: true, video_base64: base64Video, size: videoBuffer.length });

  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg API running on port ${PORT}`));
