import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
let cached;
let expires = 0;

// Core Audio lists USB inputs even before the app is allowed to record.
export function usbInputs() {
  if (process.platform !== 'darwin') return { supported:false, devices:[] };
  if (!cached || Date.now() >= expires) {
    expires = Date.now() + 4000;
    cached = run('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], { timeout:3500, maxBuffer:1024*1024 })
      .then(({stdout}) => {
        const inputs = JSON.parse(stdout).SPAudioDataType.flatMap(group => group._items || []);
        const devices = inputs.filter(d => d.coreaudio_device_transport === 'coreaudio_device_type_usb' && Number(d.coreaudio_device_input) > 0)
          .map(d => ({ name:d._name.trim(), manufacturer:d.coreaudio_device_manufacturer || '' }));
        return { supported:true, devices };
      }).catch(() => ({ supported:true, unavailable:true, devices:[] }));
  }
  return cached;
}
