const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '10mb' }));

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
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
  const { image_url, audio_id, duration = 15, width = 540, height = 960 } = req.body;

  if (!image_url) {
    return res.status(400).json({ error: 'image_url is required' });
  }

  const tmpDir = `/tmp/${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  const imagePath = path.join(tmpDir, 'input.jpg');
  const audioPath = path.join(tmpDir, 'audio.mp3');
  const outputPath = path.join(tmpDir, 'output.mp4');
  const cloudinaryUrl = path.join(tmpDir, 'upload_url.txt');

  try {
    // Download image
    await downloadFile(image_url, imagePath);

    let ffmpegCmd;

    if (audio_id) {
      const audioUrl = `https://res.cloudinary.com/dftadswre/video/upload/${audio_id}`;
      await downloadFile(audioUrl, audioPath);

      // Ultra-low memory FFmpeg command
      ffmpegCmd = `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" \
        -vf "scale=${width}:${height}:flags=lanczos,format=yuv420p" \
        -c:v libx264 -preset ultrafast -crf 28 \
        -c:a aac -b:a 96k \
        -t ${duration} -shortest \
        -threads 1 -bufsize 512k \
        "${outputPath}"`;
    } else {
      ffmpegCmd = `ffmpeg -y -loop 1 -i "${imagePath}" \
        -vf "scale=${width}:${height}:flags=lanczos,format=yuv420p" \
        -c:v libx264 -preset ultrafast -crf 28 \
        -t ${duration} \
        -threads 1 -bufsize 512k \
        "${outputPath}"`;
    }

    execSync(ffmpegCmd, { timeout: 120000 });

    // Upload directly to Cloudinary
    const FormData = require('form-data');
    const crypto = require('crypto');

    const timestamp = Math.floor(Date.now() / 1000);
    const apiSecret = 'd1518250ded051cf99604b51a7eb8f9f';
    const apiKey = '898942131569586';

    const signature = crypto
      .createHash('sha1')
      .update(`timestamp=${timestamp}upload_preset=lis_signed${apiSecret}`)
      .digest('hex');

    const form = new FormData();
    form.append('file', fs.createReadStream(outputPath));
    form.append('upload_preset', 'lis_signed');
    form.append('api_key', apiKey);
    form.append('timestamp', timestamp.toString());
    form.append('signature', signature);
    form.append('resource_type', 'video');

    const uploadResult = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.cloudinary.com',
        path: '/v1_1/dftadswre/video/upload',
        method: 'POST',
        headers: form.getHeaders()
      };

      const req = https.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(new Error('Parse error: ' + data)); }
        });
      });

      req.on('error', reject);
      form.pipe(req);
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (uploadResult.secure_url) {
      res.json({ success: true, video_url: uploadResult.secure_url });
    } else {
      res.status(500).json({ error: 'Cloudinary upload failed', details: uploadResult });
    }

  } catch (error) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg API running on port ${PORT}`));
