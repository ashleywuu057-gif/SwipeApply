"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 语音输入：用浏览器自带的语音识别（Chrome / Edge 支持）。
 * 注意：Chrome 和 Edge 会把录音发到 Google / 微软的语音服务做识别；介意的话用打字。
 */
type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

export function useSpeech(onText: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const rec = useRef<Rec | null>(null);
  const base = useRef("");
  const cb = useRef(onText);
  useEffect(() => {
    cb.current = onText;
  }, [onText]);

  useEffect(() => {
    const W = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = "zh-CN";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      cb.current(base.current + text);
    };
    r.onend = () => setListening(false);
    r.onerror = (e) => {
      setError(e.error === "not-allowed" ? "没有麦克风权限" : e.error === "network" ? "语音服务连不上（需要能访问浏览器的语音服务）" : `语音识别出错：${e.error}`);
      setListening(false);
    };
    rec.current = r;
    queueMicrotask(() => setSupported(true));
    return () => r.stop();
  }, []);

  const toggle = useCallback(
    (current: string) => {
      const r = rec.current;
      if (!r) return;
      if (listening) {
        r.stop();
        return;
      }
      setError("");
      base.current = current ? `${current} ` : "";
      try {
        r.start();
        setListening(true);
      } catch {
        setListening(false);
      }
    },
    [listening],
  );

  return { supported, listening, error, toggle };
}
