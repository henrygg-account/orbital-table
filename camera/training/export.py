"""export.py — the detector for each laptop, at the input size live.py feeds it (the screen crop, live.screen_crop).

  .venv/bin/python export.py [--weights runs/r4-seg-yolo11s-960/weights/best.pt] [--size 2048x1536] [--formats coreml,onnx]

The shape is the screen plus live.CROP_MM in the camera frame (calib.json), at the pixels per mm the model was trained
at (the whole frame at --imgsz), rounded up to 32: 512x736 (h x w) for the Oct 7 calibration instead of 960x960, about
2.4x less work. Exported models have a fixed shape (fastest on the Neural Engine and DirectML); a crop of another size
is scaled to fit it, so a small change of camera position needs no new export.
  coreml -> best.mlpackage  Mac (Neural Engine, fp16); live.py's default when present
  onnx   -> best.onnx       Windows (DirectML via onnxruntime-directml, opset 17); live.py's default there. Committed, so
                            the ThinkPad needs no export tools (installing them there would replace onnxruntime-directml)
"""
import argparse
from pathlib import Path

import live

HERE = Path(__file__).parent


def crop_shape(size, imgsz):
    fw, fh = size
    H = live.load_calib()
    if H is None:
        raise SystemExit('no calib.json: calibrate first (the export shape comes from where the screen is)')
    crop = live.screen_crop(H, (fw, fh), live.load_config()['screen_mm'])
    s = imgsz / max(fw, fh)
    return [-(-round((crop[3] - crop[1]) * s) // 32) * 32, -(-round((crop[2] - crop[0]) * s) // 32) * 32], crop


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--weights', default=str(HERE / 'runs/r4-seg-yolo11s-960/weights/best.pt'))
    ap.add_argument('--size', default='2048x1536', help='capture size WxH (as live.py --size)')
    ap.add_argument('--imgsz', type=int, default=960, help='input size for the whole frame (as trained)')
    ap.add_argument('--formats', default='coreml,onnx')
    a = ap.parse_args()
    shape, crop = crop_shape(tuple(map(int, a.size.lower().split('x'))), a.imgsz)
    print(f'crop {crop} -> model input {shape[0]}x{shape[1]} (h x w)')
    from ultralytics import YOLO
    for fmt in a.formats.split(','):
        m = YOLO(a.weights, task='segment' if '-seg' in a.weights else 'detect')
        if fmt == 'coreml':
            out = m.export(format='coreml', imgsz=shape, half=True, nms=False)
        elif fmt == 'onnx':
            out = m.export(format='onnx', imgsz=shape, opset=17, simplify=True, dynamic=False)
        else:
            raise SystemExit(f'unknown format {fmt}')
        print(fmt, '->', out)


if __name__ == '__main__':
    main()
