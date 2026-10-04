import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { installLanguageSwitcher } from './ui/i18n/runtime.js';
import './ui/i18n/i18n.css';

const disposeLanguageSwitcher = installLanguageSwitcher();
if (import.meta.hot) {
  import.meta.hot.dispose(disposeLanguageSwitcher);
}

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application
  .start()
  .then(() => {
    try {
      // The HUD summary label is mounted during startup, after the initial
      // language pass. Refresh only catalog-declared roots once the UI exists.
      disposeLanguageSwitcher.refresh();
    } catch (error) {
      console.warn("God's Eye View language refresh failed:", error);
    }
  })
  .catch((error) => {
    console.error("God's Eye View initialization failed:", error);
    const loaderStatus = document.querySelector(
      '#loading-screen .loader-status',
    );
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
  });

export { application };
