# Werewolf Game

The frontend uses Vue 3, TypeScript, PrimeVue, and the Aura theme.

## Run locally

1. Install Node.js 18 or newer.
2. Run `npm install`.
3. Run `npm run build` to type-check and compile the Vue + TypeScript frontend into `dist/`.
4. Run `npm start` and open `http://localhost:3000`. Starting the server builds the frontend first.
5. Create a room and share its six-character code. Friends open the same address and enter the code to join.

Rooms are held in server memory and disappear when the server stops. The lobby supports 4-8 connected players. The current game actions after starting are still simulated independently in each browser.

For players on separate networks, deploy the Node.js server on a host that supports WebSockets and share its public URL.

## Deploy to GitHub Pages

GitHub Pages hosts only static files. The frontend is configured to connect to `wss://werewolf-game-rdj6.onrender.com`. To deploy the Pages frontend:

```sh
npm run deploy
```

To use a different server, set `WEBSOCKET_URL` to its `wss://` URL before building and deploying. The URL is embedded in the generated frontend at build time.

1. Run `npm run deploy`. This builds `dist/` and publishes its contents to the `gh-pages` branch with Jekyll processing disabled.
2. In the repository's **Settings → Pages**, select **Deploy from a branch**, then choose `gh-pages` and `/(root)`.
3. Open the Pages URL shown in repository settings.

The WebSocket server must remain running and allow connections from your Pages site. Room creation and joining will not work if the server is asleep, unavailable, or configured to reject the Pages connection.