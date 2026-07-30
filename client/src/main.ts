import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { applyTheme, getInitialTheme } from './theme';

applyTheme(getInitialTheme());
createApp(App).mount('#app');
