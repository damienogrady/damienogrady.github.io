const video = document.getElementById('videoPlayer');
const timeSlider = document.getElementById('timeSlider');
const odoDisplay = document.getElementById('odoDisplay');
const seaLevelDisplay = document.getElementById('seaLevelDisplay');
const status = document.getElementById('status');

const MAX_AGE = 125000;
const FRAME_DURATION = 0.1;
let seaLevels;
let videoReady = false;
let videoFailed = false;
let requestedTime = 0;

function parseSeaLevels(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.shift().trim() !== 'Age,Level') {
    throw new Error('Expected Age,Level columns.');
  }
  const rows = lines.map((line, index) => {
    const fields = line.split(',');
    if (fields.length !== 2 || fields.some(field => field.trim() === '')) {
      throw new Error(`Invalid sea-level data on row ${index + 2}.`);
    }
    const age = Number(fields[0]);
    const level = Number(fields[1]);
    if (!Number.isFinite(age) || !Number.isFinite(level)) {
      throw new Error(`Invalid sea-level data on row ${index + 2}.`);
    }
    return { age, level };
  });
  if (rows.length < 2 || rows[0].age !== 0 || rows[rows.length - 1].age !== MAX_AGE ||
      rows.some((row, index) => index > 0 && row.age <= rows[index - 1].age)) {
    throw new Error('Sea-level ages must increase from 0 to 125,000 BP.');
  }
  return rows;
}

function interpolateSeaLevel(age) {
  let upper = 1;
  while (seaLevels[upper].age < age) {
    upper++;
  }
  const left = seaLevels[upper - 1];
  const right = seaLevels[upper];
  const fraction = (age - left.age) / (right.age - left.age);
  return left.level + fraction * (right.level - left.level);
}

function updateDisplay() {
  const age = Number(timeSlider.value);
  const progress = age / MAX_AGE;
  const roundedLevel = Math.round(interpolateSeaLevel(age) * 10) / 10;
  const formattedLevel = `${roundedLevel > 0 ? '+' : ''}${roundedLevel.toFixed(1)} m`;

  odoDisplay.textContent = age.toLocaleString('en-US');
  seaLevelDisplay.textContent = formattedLevel;
  timeSlider.setAttribute('aria-valuetext', `${age.toLocaleString('en-US')} years BP, sea level ${formattedLevel} relative to present`);

  // The final frame starts one frame-duration before the video ends.
  requestedTime = progress * (video.duration - FRAME_DURATION);
  video.currentTime = requestedTime;
}

function enableWhenReady() {
  if (!seaLevels || !videoReady || videoFailed) return;
  timeSlider.disabled = false;
  status.textContent = '';
  updateDisplay();
}

try {
  if (typeof SEA_LEVEL_CSV === 'undefined') {
    throw new Error('sea_level_data.js could not be loaded.');
  }
  seaLevels = parseSeaLevels(SEA_LEVEL_CSV);
} catch (error) {
  status.textContent = `Unable to load sea-level data: ${error.message}`;
}

timeSlider.addEventListener('input', updateDisplay);
function onVideoMetadata() {
  if (!Number.isFinite(video.duration) || video.duration <= FRAME_DURATION) {
    videoFailed = true;
    status.textContent = 'The video has an invalid duration.';
    return;
  }
  videoReady = true;
  enableWhenReady();
}
video.addEventListener('loadedmetadata', onVideoMetadata);
video.addEventListener('seeked', () => {
  if (Math.abs(video.currentTime - requestedTime) > 0.005) {
    status.textContent = 'The video could not seek to this age. Use a web server that supports byte-range requests.';
  } else if (videoReady && seaLevels && !videoFailed) {
    status.textContent = '';
  }
});
video.addEventListener('error', () => {
  videoFailed = true;
  timeSlider.disabled = true;
  status.textContent = 'Unable to load the coastline video. Please check the video file and browser support.';
});
if (video.readyState >= 1) onVideoMetadata();
