# FIA CaM

FIA CaM is a fan-made Everon cache mapper for *Arma Reforger*. Enter one to five FIA shopping-list coordinates to highlight their approximate one-kilometre search squares, or photograph the list and extract its coordinates with local server-side OCR.

## Features

- Five Easting/Northing coordinate rows
- Exact Everon grid overlay and highlighted search squares
- Automatic framing of every plotted location
- Mouse, touch, zoom and pan controls
- Responsive phone and desktop layouts
- Camera/photo input with local Tesseract OCR
- Uploaded photos are processed in memory and are not retained

## Requirements

- Node.js 18 or newer
- HTTPS for camera access on phones

## Run

```sh
npm ci --omit=dev
npm start
```

The server listens on the port supplied through `PORT`, defaulting to `8080` locally.

OCR requests are limited to three scans per IP address in each rolling minute. Set `OCR_RATE_LIMIT` to a positive whole number to override that default.

## cPanel deployment

Create a production Node.js application using Node 20 or 22, select `server.js` as its startup file, connect this repository, install its npm dependencies, and restart the application. Do not set `PORT` manually when the hosting platform supplies it.

The first OCR scan after a process restart can take longer while Tesseract initializes. The bundled English recognition data is stored in `.ocr-cache/eng.traineddata` so the server does not need to download it at first use.

## Acknowledgments and licenses

This is an unofficial fan-made tool and is not affiliated with or endorsed by Bohemia Interactive. *Arma Reforger*, the Everon map imagery and associated intellectual property belong to Bohemia Interactive a.s.

The high-resolution map was compiled and stitched from in-game screenshots by Steam Community creator Heisenburger. See [their original Steam Community guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2816709014).

OCR is powered by Tesseract.js and the Tesseract OCR engine. See `THIRD_PARTY_NOTICES.txt` and `APACHE-2.0.txt` for licensing information.
