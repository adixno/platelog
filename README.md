# PlateLog

A phone web app for tracking calories from photos. Photograph a meal, Claude estimates each food's weight, calories, protein, carbs, sugar and fat, you correct the portions, and the app tracks the day against your goals. It also keeps a weight log.

- No server and no build step: plain HTML, CSS and JavaScript.
- Meals, weights, settings and the API key are stored only in the browser on your device.
- Photo analysis needs your own Claude API key (console.anthropic.com), entered in Settings. Each analysis is billed to that key.
- Add `?demo` to the URL to try the flow with sample data and no key.

Estimates from a photo are approximate. Check the portion weights on the review screen; a kitchen scale makes them exact.
