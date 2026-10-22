# Werewolf Game

## Run locally

1. Install Node.js 18 or newer.
2. Run `npm install`.
3. Run `npm start` and open `http://localhost:3000`.
4. Create a room and share its six-character code. Friends open the same address and enter the code to join.

Rooms are held in server memory and disappear when the server stops. The lobby supports 4-8 connected players. The current game actions after starting are still simulated independently in each browser.

For players on separate networks, deploy the Node.js server on a host that supports WebSockets and share its public URL.