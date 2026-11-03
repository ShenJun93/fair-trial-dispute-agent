#!/usr/bin/env python3
"""FT069: video editing from authentic, local, mock-only browser capture."""
from __future__ import annotations
import hashlib,json,math,subprocess,sys,wave,re
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'out'/'ft069-video'
OUT.mkdir(parents=True,exist_ok=True)
NARRATION=json.loads((ROOT/'scripts'/'ft069-narration.json').read_text('utf-8'))
CAPTURE=json.loads((OUT/'capture-manifest.json').read_text('utf-8'))
assert CAPTURE['status']=='PASS' and CAPTURE['providerMode']=='MOCK'
assert not CAPTURE['errors'] and not CAPTURE['external']
assert CAPTURE['observedExternalNetworkRequests']==0 and CAPTURE['observedProviderMutationCount']==0
assert [x['tag'] for x in NARRATION]==['Opening','Inspect','Run','Synthetic','Explain','Closing']
ffmpeg='ffmpeg';ffprobe='ffprobe'
def run(args):
    p=subprocess.run(args,capture_output=True,text=True,encoding='utf-8',errors='replace')
    if p.returncode:
        print('COMMAND FAILED:',args[:8], '\n',p.stderr[-5000:],file=sys.stderr)
        raise RuntimeError('video_command_failed')
    return p
def probe(path):
    return json.loads(run([ffprobe,'-v','error','-show_format','-show_streams','-of','json',str(path)]).stdout)
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()
def font(name,size):
    p=Path('C:/Windows/Fonts')/name
    if not p.exists():p=Path('C:/Windows/Fonts/arial.ttf')
    return ImageFont.truetype(str(p),size)
F_TAG=font('segoeuib.ttf',32);F_SERIF=font('georgia.ttf',100);F_HEAVY=font('segoeuib.ttf',54)
F_BODY=font('segoeui.ttf',34);F_SMALL=font('segoeui.ttf',27);F_BADGE=font('consolab.ttf',25)
W,H=1920,1080
CREAM='#f6eee8';CORAL='#f0775d';PAPER='#fcfaf7'
def canvas():
    im=Image.new('RGB',(W,H))
    pix=im.load()
    for y in range(H):
        t=y/H
        color=(int(26+7*t),int(25+4*t),int(24+4*t))
        ImageDraw.Draw(im).line((0,y,W,y),fill=color)
    return im
def pill(draw,xy,label):
    x,y=xy; tw=draw.textbbox((0,0),label,font=F_BADGE)[2]; ww=tw+60
    draw.rounded_rectangle((x,y,x+ww,y+64),radius=32,outline='#9e8178',width=2,fill='#302b29')
    draw.text((x+30,y+18),label,font=F_BADGE,fill='#f4dccf')
def draw_footer(draw,number):
    draw.line((100,934,1820,934),fill='#806e65',width=2)
    draw.text((100,963),'FAIR TRIAL  /  LOCAL JUDGE DEMO',font=F_SMALL,fill='#c1aea4')
    draw.text((1570,963),number,font=F_SMALL,fill=CORAL)
def slide_open():
    im=canvas();d=ImageDraw.Draw(im)
    d.rounded_rectangle((100,115,126,195),radius=12,fill=CORAL)
    d.text((155,130),'FAIR TRIAL',font=F_TAG,fill=CORAL)
    pill(d,(1240,119),'READ-ONLY SANDBOX + MOCK')
    d.text((110,295),'When evidence is missing,',font=F_SERIF,fill=PAPER)
    d.text((110,423),'the answer is HOLD.',font=F_SERIF,fill=PAPER)
    d.text((115,620),'An evidence-first, human-bound dispute review workflow.',font=F_BODY,fill='#e9dacf')
    d.text((115,689),'Inspect  /  Run  /  Explain',font=F_HEAVY,fill=CORAL)
    draw_footer(d,'01 / 06')
    im.save(OUT/'intro.png')
def slide_close():
    im=canvas();d=ImageDraw.Draw(im)
    d.rounded_rectangle((100,115,126,195),radius=12,fill=CORAL)
    d.text((155,130),'FAIR TRIAL',font=F_TAG,fill=CORAL)
    pill(d,(1230,119),'NO PROVIDER MUTATION')
    d.text((110,288),'Evidence first.',font=F_SERIF,fill=PAPER)
    d.text((110,413),'Human decisions.',font=F_SERIF,fill=PAPER)
    d.text((113,613),'PROVED:  Historical Sandbox identity + local bounded workflow',font=F_BODY,fill='#cae1d4')
    d.text((113,674),'NOT CLAIMED:  Live challenge, verified merchant uploads, issuer win',font=F_BODY,fill='#efc6a4')
    d.text((113,745),'NEXT GATE:  Real evidence, fresh provider read, specific approval',font=F_BODY,fill='#dfd0c7')
    draw_footer(d,'06 / 06')
    im.save(OUT/'outro.png')
slide_open();slide_close()

# Windows local TTS: source text remains versioned, WAVs and rendered output are ignored QA artifacts.
ps=OUT/'make_voice.ps1'
ps.write_text("""$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$v=New-Object System.Speech.Synthesis.SpeechSynthesizer
$v.SelectVoice('Microsoft Zira Desktop')
$v.Rate=0
$v.Volume=100
$rows=Get-Content -LiteralPath '"""+str((ROOT/'scripts'/'ft069-narration.json')).replace("'","''")+"""' -Raw | ConvertFrom-Json
for($i=0;$i -lt $rows.Count;$i++){
 $name=('voice_{0:D2}.wav' -f $i)
 $file=Join-Path '"""+str(OUT).replace("'","''")+"""' $name
 $v.SetOutputToWaveFile($file)
 $v.Speak([string]$rows[$i].text)
 $v.SetOutputToNull()
}
$v.Dispose()
""",encoding='utf-8')
run(['pwsh','-NoProfile','-File',str(ps)])

WAVS=[OUT/f'voice_{i:02}.wav' for i in range(len(NARRATION))]
wavinfo=[]
for p in WAVS:
    with wave.open(str(p),'rb') as w:
        wavinfo.append({'rate':w.getframerate(),'width':w.getsampwidth(),'channels':w.getnchannels(),'frames':w.getnframes(),'duration':w.getnframes()/w.getframerate()})
assert len({(x['rate'],x['width'],x['channels']) for x in wavinfo})==1
sr=wavinfo[0]['rate'];width=wavinfo[0]['width'];ch=wavinfo[0]['channels']
GAP=.7
scene_durations=[]
voice=OUT/'voiceover.wav'
with wave.open(str(voice),'wb') as o:
    o.setnchannels(ch);o.setsampwidth(width);o.setframerate(sr)
    for i,f in enumerate(WAVS):
        with wave.open(str(f),'rb') as x:o.writeframes(x.readframes(x.getnframes()))
        padding=round(sr*GAP)
        o.writeframes(b'\x00'*(padding*width*ch))
        scene_durations.append(wavinfo[i]['duration']+padding/sr)
voice_duration=sum(scene_durations)
print('VOICEOVER_SECONDS',round(voice_duration,2),'SCENE_SECONDS',[round(x,1) for x in scene_durations])
assert voice_duration<285,'video must remain under five minutes'

def stamp(sec):
    ms=round(max(0,sec)*1000)
    return f'{ms//3600000:02}:{(ms//60000)%60:02}:{(ms//1000)%60:02},{ms%1000:03}'
def words_chunked(text,n=10):
    words=text.split();return [' '.join(words[i:i+n]) for i in range(0,len(words),n)]
srt=[];ix=1;cursor=0
for row,wi in zip(NARRATION,wavinfo):
    chunks=words_chunked(row['text'],11)
    lengths=[len(x) for x in chunks];total=sum(lengths)
    elapsed=0
    for txt,ln in zip(chunks,lengths):
        duration=wi['duration']*ln/total
        start=cursor+elapsed;stop=start+duration
        srt.append(f'{ix}\n{stamp(start)} --> {stamp(stop)}\n{txt}\n')
        ix+=1;elapsed+=duration
    cursor+=wi['duration']+GAP
(OUT/'fair-trial-ft069-judge-demo.srt').write_text('\n'.join(srt),encoding='utf-8')

# Segment the genuine Playwright recording by measured source timestamps.
raw=OUT/'raw-browser.webm'; marks={x['name']:x['seconds'] for x in CAPTURE['marks']}
offset=float(CAPTURE['preludeTrimSeconds'])
bounds=[
  (0,marks['run_provider_setup']),
  (marks['run_provider_setup'],marks['run_synthetic_setup']),
  (marks['run_synthetic_setup'],marks['explain_synthetic_result']),
  (marks['explain_synthetic_result'],marks['recording_end'])
]
assert all(b>a+3 for a,b in bounds)
def encode_still(pic,duration,out):
    run([ffmpeg,'-hide_banner','-loglevel','error','-y','-loop','1','-framerate','25','-i',str(pic),
       '-t',f'{duration:.4f}','-c:v','libx264','-preset','veryfast','-crf','20',
       '-pix_fmt','yuv420p','-r','25','-an',str(out)])
def encode_body(a,b,target,path):
    original=b-a
    factor=target/original
    run([ffmpeg,'-hide_banner','-loglevel','error','-y','-ss',f'{offset+a:.3f}','-t',f'{original:.3f}','-i',str(raw),
        '-vf',f'setpts={factor:.7f}*(PTS-STARTPTS),fps=25,scale=1920:1080:flags=lanczos',
        '-t',f'{target:.4f}','-c:v','libx264','-preset','veryfast','-crf','20',
        '-pix_fmt','yuv420p','-r','25','-an',str(path)])
segments=[OUT/f'segment-{i:02}.mp4' for i in range(6)]
encode_still(OUT/'intro.png',scene_durations[0],segments[0])
for i,(a,b) in enumerate(bounds):encode_body(a,b,scene_durations[i+1],segments[i+1])
encode_still(OUT/'outro.png',scene_durations[-1],segments[-1])
filelist=OUT/'concat.txt'
filelist.write_text(''.join("file '"+s.resolve().as_posix()+"'\n" for s in segments),encoding='utf-8')
final=OUT/'fair-trial-ft069-judge-demo.mp4'
run([ffmpeg,'-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(filelist),'-i',str(voice),
     '-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','160k','-ar','48000','-movflags','+faststart',
     '-shortest',str(final)])
metadata=probe(final)
videoStream=next(x for x in metadata['streams'] if x['codec_type']=='video')
audioStream=next(x for x in metadata['streams'] if x['codec_type']=='audio')
duration=float(metadata['format']['duration'])
assert duration<300 and duration>80, duration
assert int(videoStream['width'])==1920 and int(videoStream['height'])==1080
assert audioStream['codec_name']=='aac' and videoStream['codec_name']=='h264'
result={'schema':'FT069_JUDGE_VIDEO_RENDER_V1','status':'RENDERED_QA_PENDING',
 'renderedVideo':final.name,'sha256':sha(final),'bytes':final.stat().st_size,
 'durationSeconds':duration,'resolution':'1920x1080','videoCodec':'h264','audioCodec':'aac',
 'voiceEngine':'Windows System.Speech / Microsoft Zira Desktop',
 'introAndOutro':'designed narration title cards','browserScenes':'actual Playwright 1600x900 authenticated local MOCK recording',
 'captureSha256':CAPTURE['sha256'],'sourceCommit':'aa040df','sourceSnapshot':'2026-11-02T23:50:31.968Z',
 'claims':['historical provider readback','zero provider mutations in recording','offline deterministic planner',
           'synthetic high-value evidence replan','human review and no issuer outcome'],
 'limitations':['not live provider status','no merchant-evidence authenticity','no new financial API action',
               'human audio and visual quality review still required'],
 'chapterSeconds':scene_durations,'captionFile':'fair-trial-ft069-judge-demo.srt'}
(OUT/'render-manifest.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print('RENDER_RESULT',json.dumps(result))
# Final reproducible edit: burn the 28 SRT caption cues directly into the MP4.
captioned=OUT/'fair-trial-ft069-judge-demo-captioned.mp4'
run([ffmpeg,'-hide_banner','-loglevel','error','-y','-i',str(final),
     '-vf',"subtitles=out/ft069-video/fair-trial-ft069-judge-demo.srt:force_style='Fontname=Arial,Fontsize=23,Outline=2,Shadow=0,MarginV=28,Alignment=2'",
     '-c:v','libx264','-preset','veryfast','-crf','21','-c:a','copy','-movflags','+faststart',str(captioned)])
result['captionedVideo']=captioned.name
result['captionedSha256']=sha(captioned)
result['captionedBytes']=captioned.stat().st_size
result['captionedDurationSeconds']=float(probe(captioned)['format']['duration'])
(OUT/'render-manifest.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print('CAPTIONED_RESULT',json.dumps({k:result[k] for k in ('captionedVideo','captionedSha256','captionedBytes','captionedDurationSeconds')}))
