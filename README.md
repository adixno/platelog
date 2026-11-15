# PlateLog

A phone web app for tracking calories from photos. Photograph a meal, an AI model estimates each food's weight, calories, protein, carbs, sugar and fat, you correct the portions, and the app tracks the day against your goals. It also keeps a weight log.

- No server and no build step: plain HTML, CSS and JavaScript.
- Meals, weights, settings and keys are stored only in the browser on your device.
- Photo analysis is free with a Google Gemini key from aistudio.google.com/apikey, entered once in Settings. Google may use free-tier photos to improve its products. Paid Claude models are an optional alternative.
- Add `?demo` to the URL to try the flow with sample data and no key.

Estimates from a photo are approximate. Check the portion weights on the review screen; a kitchen scale makes them exact.
