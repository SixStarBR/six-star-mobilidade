'use strict';

(() => {
  const installButton = document.getElementById('installApp');
  const toast = document.getElementById('toast');
  let installPrompt = null;
  let toastTimer;

  function notify(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 5200);
  }

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    if (installButton) installButton.classList.add('install-available');
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    if (installButton) installButton.classList.remove('install-available');
    notify('Vértice instalado. Você pode abrir o app pela tela inicial.');
  });

  if (installButton) {
    installButton.addEventListener('click', async () => {
      if (!window.isSecureContext) {
        notify('A instalação e o GPS precisam de uma conexão HTTPS segura.');
        return;
      }
      if (isInstalled) {
        notify('O Vértice já está instalado neste dispositivo.');
        return;
      }
      if (installPrompt) {
        installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') notify('A instalação do Vértice foi iniciada.');
        installPrompt = null;
        installButton.classList.remove('install-available');
        return;
      }
      if (isIOS) {
        notify('No iPhone ou iPad: abra no Safari, toque em Compartilhar e escolha “Adicionar à Tela de Início”.');
      } else {
        notify('No Android: abra o menu do navegador e escolha “Instalar app” ou “Adicionar à tela inicial”.');
      }
    });
  }

  window.addEventListener('offline', () => {
    const offlineNotice = document.getElementById('driverOffline');
    if (offlineNotice) offlineNotice.hidden = false;
    notify('Sem conexão. O app abre, mas agenda e GPS precisam da internet.');
  });
  window.addEventListener('online', () => {
    const offlineNotice = document.getElementById('driverOffline');
    if (offlineNotice) offlineNotice.hidden = true;
    notify('Conexão restabelecida.');
  });
  if (!navigator.onLine) {
    const offlineNotice = document.getElementById('driverOffline');
    if (offlineNotice) offlineNotice.hidden = false;
  }

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch(() => notify('Não foi possível preparar o modo instalável neste endereço.'));
    }, { once: true });
  }
})();
