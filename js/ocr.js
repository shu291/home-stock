let worker;
// レシート画像 → テキスト(端末内で処理。画像は外部に送られない)
export async function ocr(file, onProgress) {
  if (!window.Tesseract) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('OCRの読み込みに失敗'));
      document.head.appendChild(s);
    });
  }
  worker ||= await Tesseract.createWorker('jpn+eng', 1, { logger: (m) => m.status === 'recognizing text' && onProgress?.(m.progress) });
  const { data } = await worker.recognize(file);
  return data.text;
}
