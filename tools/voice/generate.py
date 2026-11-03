#!/usr/bin/env python3
"""
Navigációs hangfájlok generálása (Piper, offline neurális felolvasó).

Minden hanghoz egy „sprite” készül: assets/voice/<hang>.mp3 (az összes mondatelem egymás után,
kis szünettel) és assets/voice/<hang>.json ({ kulcs: [kezdet_mp, hossz_mp] }). A navigáció
(src/ui/navigation.js) a kulcsokból rakja össze a mondatot; a kulcsoknak a két helyen egyezniük kell.

Hangok: Piper magyar hangok (rhasspy/piper-voices, hu_HU, medium) – az adatkészlet CC0.

Használat (a repó gyökeréből):
  python3 -m venv /tmp/piper && /tmp/piper/bin/pip install piper-tts
  /tmp/piper/bin/python tools/voice/generate.py --models <mappa a .onnx fájlokkal>
A modellek: https://huggingface.co/rhasspy/piper-voices/tree/main/hu/hu_HU (berta, imre – medium)
Kell hozzá: ffmpeg.
"""
import argparse, json, os, subprocess, tempfile, wave

VOICES = {"berta": "hu_HU-berta-medium.onnx", "imre": "hu_HU-imre-medium.onnx"}
GAP = 0.25   # szünet a mondatelemek között a sprite-ban (mp)

ONES = ["", "egy", "kettő", "három", "négy", "öt", "hat", "hét", "nyolc", "kilenc"]
TENS = {10: "tíz", 20: "húsz", 30: "harminc", 40: "negyven", 50: "ötven", 60: "hatvan", 70: "hetven", 80: "nyolcvan", 90: "kilencven"}
TENS_PFX = {10: "tizen", 20: "huszon"}
HUND = ["", "száz", "kétszáz", "háromszáz", "négyszáz", "ötszáz", "hatszáz", "hétszáz", "nyolcszáz", "kilencszáz"]

def words(n):
    """10–999 magyarul (a navigáció távjaihoz)."""
    h, r = divmod(n, 100)
    t, o = divmod(r, 10)
    s = HUND[h]
    if r:
        if o and t * 10 in TENS_PFX: s += TENS_PFX[t * 10] + ONES[o]
        else: s += (TENS.get(t * 10, "") + ONES[o])
    return s

# távok: ahogy a navigáció kerekít (fmtDist): 100 m alatt 10-esével, felette 50-esével
DISTS = list(range(10, 100, 10)) + list(range(100, 1000, 50))

# irányutasítások – azonosító → szöveg (a navigation.js hintId() ugyanezeket adja)
INSTR = {
    "c": "egyenesen tovább", "tl": "balra", "tsll": "enyhén balra", "tshl": "élesen balra",
    "tr": "jobbra", "tslr": "enyhén jobbra", "tshr": "élesen jobbra", "kl": "tarts balra", "kr": "tarts jobbra",
    "tu": "fordulj vissza", "el": "a kijáraton balra", "er": "a kijáraton jobbra",
    "rb": "a körforgalomban tovább", "join": "rátérsz az útvonalra",
}
ORD = ["", "első", "második", "harmadik", "negyedik", "ötödik", "hatodik"]
for n in range(1, 7): INSTR[f"rb{n}"] = f"a körforgalomból a {ORD[n]} kijáraton"
# turistajelzések: szín × forma (a magyar jelzésrendszer) + Kéktúra + általános
COLORS = {"k": "kék", "p": "piros", "s": "sárga", "z": "zöld"}
SHAPES = {"": "sávon", "+": "kereszten", "3": "háromszögön", "q": "körön", "4": "négyzeten"}
for c, cn in COLORS.items():
    for sh, sw in SHAPES.items():
        INSTR[f"t{c}{sh}"] = f"a {cn} {sw} tovább"
INSTR["tokt"] = "a Kéktúrán tovább"
INSTR["tany"] = "a jelzésen tovább"
TRAIL_KEYS = {f"t{c}{sh}" for c in COLORS for sh in SHAPES} | {"tokt", "tany"}

EVENTS = {
    "start": "Navigáció indul.", "where": "Honnan indulsz?", "off": "Letértél az útvonalról.",
    "back": "Visszatértél az útvonalra.", "end": "Megérkeztél.", "voiceon": "Hang bekapcsolva.",
    "approach": "Bekötés az útvonalra.", "resume": "Folytatás innen.",
}

def phrases():
    out = {}
    for d in DISTS: out[f"d{d}"] = f"{words(d).capitalize()} méter múlva"
    for k, t in INSTR.items():
        out[f"i:{k}"] = t + "."
        # „Most …” – a jelzésnél és a rátérésnél „Innen …” / „Itt …”
        pre = "Innen" if k in TRAIL_KEYS else "Itt" if k == "join" else "Most"
        out[f"n:{k}"] = f"{pre} {t}."
        out[f"m:{k}"] = f"majd {t}."
    for k, t in EVENTS.items(): out[f"e:{k}"] = t
    return out

def run(cmd): subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--out", default="assets/voice")
    a = ap.parse_args()
    from piper import PiperVoice
    os.makedirs(a.out, exist_ok=True)
    items = phrases()
    for name, fn in VOICES.items():
        voice = PiperVoice.load(os.path.join(a.models, fn))
        with tempfile.TemporaryDirectory() as tmp:
            parts, manifest, t = [], {}, 0.0
            rate = None
            for i, (key, text) in enumerate(items.items()):
                raw, cut = f"{tmp}/{i}.wav", f"{tmp}/{i}c.wav"
                with wave.open(raw, "wb") as w: voice.synthesize_wav(text, w)
                # elején-végén a csend levágása
                run(["ffmpeg", "-y", "-i", raw, "-af",
                     "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse", cut])
                with wave.open(cut) as w:
                    rate = rate or w.getframerate()
                    dur = w.getnframes() / w.getframerate()
                manifest[key] = [round(t, 3), round(dur, 3)]
                parts.append(cut)
                t += dur + GAP
            # összefűzés szünetekkel → mp3 (mono, 48 kbps)
            gap = f"{tmp}/gap.wav"
            run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={rate}:cl=mono", "-t", str(GAP), gap])
            lst = f"{tmp}/list.txt"
            with open(lst, "w") as f:
                for p in parts: f.write(f"file '{p}'\nfile '{gap}'\n")
            run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-ac", "1", "-b:a", "48k", f"{a.out}/{name}.mp3"])
        with open(f"{a.out}/{name}.json", "w") as f: json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
        print(name, len(manifest), "elem", round(t), "mp")

if __name__ == "__main__":
    main()
