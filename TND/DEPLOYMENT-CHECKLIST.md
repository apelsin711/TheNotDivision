# TND deployment checklist

- [ ] GitHub repository contains the contents of this folder at its root.
- [ ] Render web service is Live.
- [ ] `https://YOUR-RENDER-HOST/health` returns status `ok`.
- [ ] Netlify deploy uses publish directory `static` and no build command.
- [ ] `static/config.js` contains the actual Render HTTPS URL.
- [ ] Render `FRONTEND_ORIGINS` contains the exact Netlify site URL.
- [ ] Netlify redeploy and Render restart have completed.
- [ ] Room creation works in one browser.
- [ ] Joining the same room from a second browser/device works.
- [ ] Chat, queue, voting, and reactions work across both clients.
- [ ] Microphone permission is granted and WebRTC voice is tested on separate networks.
