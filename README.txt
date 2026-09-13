FIA CaM

QUICK LOCAL USE (MANUAL ENTRY)
Open index.html directly. Mapping works without an install, server, or internet connection.

HTTPS SERVER WITH CAMERA OCR
Requirements: Node.js 18 or newer and your HTTPS reverse proxy.

1. Upload this complete folder to the server.
2. Run: npm install
3. Run: npm start
4. Point the HTTPS site/reverse proxy at the Node service. PORT defaults to 8080.

The browser sends the selected shopping-list photo only to this server's /api/scan endpoint. Tesseract performs OCR locally on your server. Photos are processed in memory, never saved to disk, and their temporary buffers are cleared after each scan. They are not sent to OpenAI or another OCR provider, and there is no per-scan fee. Tesseract may download its English recognition data when it is first initialized and then caches only that reusable language model locally.

COORDINATE FORMAT
Enter Easting 065 and Northing 031. One to five complete rows may be used.

MAPS
Everon, Arland and Kolguyev are supported. Each map keeps its own coordinate list and markers. Shared links open the selected map automatically.

LICENSES
FIA CaM original material: CC BY-NC-SA 4.0. Third-party material remains under its respective license. See LICENSE, THIRD_PARTY_NOTICES.txt, APACHE-2.0.txt, APL-SA.txt, and STARDOS-STENCIL-OFL.txt.
