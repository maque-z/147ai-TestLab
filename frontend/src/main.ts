import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from './App.vue'
import router from './router'
import './assets/styles/global.css'

// Deliberately no `app.use(naive)`. Registering the library globally pulls every
// component into the bundle, including the ~80 this app never renders. Each
// component that is used imports itself by name in its own <script setup>, which
// is what lets the bundler drop the rest — the global registration was pure
// duplication on top of that, worth ~500 kB of the main chunk.
//
// The consequence to remember: a component added to a template from now on has
// to be imported in that same file. Without the global registration Vue resolves
// an unknown <n-foo> to nothing and renders an empty element, silently.
const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

const app = createApp(App)
app.use(pinia)
app.use(router)
app.mount('#app')
