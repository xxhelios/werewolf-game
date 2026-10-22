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