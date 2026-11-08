import { App } from './app';

if (!('createImageBitmap' in window)) {
  document.body.innerHTML =
    '<p style="padding:24px;font-family:sans-serif">このブラウザは対応していません。最新の Chrome / Edge / Firefox をお使いください。</p>';
} else {
  new App().start();
}
