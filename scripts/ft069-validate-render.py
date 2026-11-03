#!/usr/bin/env python3
"""Local, read-only quality gate for the FT069 render. Does not play or upload the video."""
import hashlib,json,re,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parent.parent
out=root/"out"/"ft069-video"
capture=json.loads((out/"capture-manifest.json").read_text("utf-8"))
render=json.loads((out/"render-manifest.json").read_text("utf-8"))
def sha(p):
 h=hashlib.sha256()
 with p.open("rb") as f:
  for b in iter(lambda:f.read(1024*1024),b""):h.update(b)
 return h.hexdigest()
def probe(p):
 r=subprocess.run(["ffprobe","-v","error","-show_streams","-show_format","-of","json",str(p)],capture_output=True,text=True,check=True)
 return json.loads(r.stdout)
assert capture["status"]=="PASS" and capture["providerMode"]=="MOCK"
assert capture["realBrowserInteractions"] is True
assert capture["observedExternalNetworkRequests"]==0 and capture["observedProviderMutationCount"]==0
assert len(capture["workflow"])==2 and capture["workflow"][0]=="provider-rfi"
assert capture["errors"]==[] and capture["external"]==[]
assert sha(out/"raw-browser.webm")==capture["sha256"]
assert sha(out/render["renderedVideo"])==render["sha256"]
final=out/"fair-trial-ft069-judge-demo-captioned.mp4"
info=probe(final)
dur=float(info["format"]["duration"])
video=next(x for x in info["streams"] if x["codec_type"]=="video")
audio=next(x for x in info["streams"] if x["codec_type"]=="audio")
assert 80<dur<300, dur
assert video["codec_name"]=="h264" and video["width"]==1920 and video["height"]==1080
assert audio["codec_name"]=="aac"
assert abs(dur-float(render["durationSeconds"]))<0.5
srt=(out/render["captionFile"]).read_text("utf-8")
assert len(re.findall(r"--> ",srt))>=12
assert "HOLD" in srt and "synthetic" in srt.lower() and "Airwallex" in srt
src=(root/"scripts"/"ft069-narration.json").read_text("utf-8")
for forbidden in ("provider mutation was completed","challenge submitted successfully","issuer decided in our favor","real-time model inference"):
 assert forbidden.lower() not in src.lower()
result={"schema":"FT069_VIDEO_QA_V1","status":"AUTOMATED_CHECKS_PASS_HUMAN_REVIEW_PENDING",
 "file":str(final),"sha256":sha(final),"sizeBytes":final.stat().st_size,
 "durationSeconds":dur,"resolution":"1920x1080","videoCodec":"h264","audioCodec":"aac",
 "captureMode":"MOCK","providerMutations":0,"externalRequests":0,
 "realBrowserScenarios":capture["workflow"],"subtitleCount":len(re.findall(r"--> ",srt)),
 "knownLimits":["Narration playback has not been independently listened to end-to-end",
               "Automated tests do not establish accessibility compliance or final visual quality",
               "Neither provider challenge nor issuer outcome verified",
               "HackerEarth portal exact upload requirements not independently confirmed"]}
(out/"video-qa.json").write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
print(json.dumps(result))
