import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './store';
import App from './App';
import { initTheme } from './lib/theme';
import { initNotificationSoundUnlock } from './lib/notify';
import './index.css';

// Страховка к inline-скрипту в index.html: синхронизирует тему,
// если её состояние менялось через toggleTheme в прошлом сеансе
initTheme();

// Звук оповещений: AudioContext разблокируется по первому жесту пользователя
// (клик/тап/клавиша). Делаем это на старте приложения, а не в Layout — иначе
// жест на странице логина не засчитывается и первые оповещения приходят беззвучно.
initNotificationSoundUnlock();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>
);