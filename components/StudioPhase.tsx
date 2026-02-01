import React, { useState, useRef, useEffect, useMemo } from 'react';
import { AudioTrack, VisualSettings, EncodingSettings, SpectrumStyle, FilterPreset, ScreenEffect, ParticleEffect, SetupImages } from '../types';
import { DEFAULT_VISUAL_SETTINGS } from '../constants';
import { VisualizerCanvas } from './VisualizerCanvas';
import { 
  Play, Pause, Download, 
  Settings, ImageIcon, Layers, Wand2, Palette,
  Move, Trash2, Heart, Flame, Layout, Sliders,
  X, CloudSnow, CloudFog, Flower2, Sun,
  Activity, Film, Zap, PartyPopper, Check,
  Sunrise, Camera, ScanLine, Monitor, Gauge,
  ArrowUp, ArrowDown
} from './IconComponents';

interface StudioPhaseProps {
  playlist: AudioTrack[];
  onBack: () => void;
  initialImages: SetupImages;
  encodingSettings: EncodingSettings;
}

const PALETTE_COLORS = [
  '#5B6EE1', '#FF0055', '#00FF99', '#FFCC00', 
  '#00CCFF', '#FFFFFF', '#FF6600', '#CC00FF', 
  '#00FF00', '#0000FF', '#FF00FF', '#FFFF00', 
  '#00FFFF', '#000000', '#808080'
];

// Render Presets
interface RenderConfig {
  id: 'high' | 'balanced' | 'fast';
  label: string;
  fps: number;
  bitrate: number;
  description: string;
}

const RENDER_PRESETS: RenderConfig[] = [
  { id: 'high', label: '고화질 (60fps)', fps: 60, bitrate: 8000000, description: '부드러운 움직임, 고사양 PC 권장' },
  { id: 'balanced', label: '일반 (30fps)', fps: 30, bitrate: 5000000, description: '권장 설정, 멈춤 없이 안정적' },
  { id: 'fast', label: '저사양 (30fps)', fps: 30, bitrate: 2500000, description: '빠른 처리, 용량 절약' },
];

export const StudioPhase: React.FC<StudioPhaseProps> = ({ playlist: initialPlaylist, onBack, initialImages, encodingSettings }) => {
  // State
  const [playlist, setPlaylist] = useState<AudioTrack[]>(initialPlaylist);
  const [settings, setSettings] = useState<VisualSettings>(() => ({
    ...DEFAULT_VISUAL_SETTINGS,
    backgroundImage: initialImages.backgroundImage || DEFAULT_VISUAL_SETTINGS.backgroundImage,
    logoImage: initialImages.logoImage || DEFAULT_VISUAL_SETTINGS.logoImage
  }));

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [currentLoopIteration, setCurrentLoopIteration] = useState(0);
  
  // Rendering State
  const [isRendering, setIsRendering] = useState(false);
  const [showRenderModal, setShowRenderModal] = useState(false);
  const [renderFilename, setRenderFilename] = useState("My_Spectrum_Video");
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStatusText, setRenderStatusText] = useState(""); 
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  
  // Render Quality State
  const [selectedPreset, setSelectedPreset] = useState<RenderConfig>(RENDER_PRESETS[1]); // Default to Balanced (30fps)

  // Refs
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  
  // Streaming Refs (For direct disk write)
  const writableStreamRef = useRef<any>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve()); 
  
  // Audio Graph Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const destNodeRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null); 

  // Calculations
  const playlistDuration = useMemo(() => playlist.reduce((acc, t) => acc + t.duration, 0), [playlist]);
  const totalDuration = useMemo(() => playlistDuration * encodingSettings.loopCount, [playlistDuration, encodingSettings.loopCount]);

  // Helpers
  const updateSetting = <K extends keyof VisualSettings>(key: K, value: VisualSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleAudioInit = () => {
    if (!audioContextRef.current) {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContext();
    }
  };

  // Audio Graph Setup
  useEffect(() => {
    handleAudioInit();
    return () => { audioContextRef.current?.close(); };
  }, []);

  useEffect(() => {
    if (audioRef.current && audioContextRef.current && !sourceNodeRef.current) {
      try {
        const ctx = audioContextRef.current;
        const source = ctx.createMediaElementSource(audioRef.current);
        sourceNodeRef.current = source;
        
        // 1. Analyser (Shared)
        const ana = ctx.createAnalyser();
        ana.fftSize = 2048;
        source.connect(ana);
        setAnalyser(ana);
        
        // 2. Speaker Output (via GainNode for Muting)
        const gain = ctx.createGain();
        gain.gain.value = 1.0; // Default Unmuted
        ana.connect(gain);
        gain.connect(ctx.destination);
        gainNodeRef.current = gain;

        // 3. Recorder Output (Always Connected)
        const dest = ctx.createMediaStreamDestination();
        destNodeRef.current = dest;
        source.connect(dest); 
        
      } catch (e) { console.error("Audio graph error", e); }
    }
  }, [audioRef.current]);

  // Playback Logic
  const handlePlayPause = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        if (audioContextRef.current?.state === 'suspended') audioContextRef.current.resume();
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const playTrack = (index: number) => {
    setCurrentTrackIndex(index);
    setIsPlaying(true);
  };

  const handleTrackEnd = () => {
    if (currentTrackIndex < playlist.length - 1) {
      setCurrentTrackIndex(prev => prev + 1);
    } else {
      if (currentLoopIteration < encodingSettings.loopCount - 1) {
        setCurrentLoopIteration(prev => prev + 1);
        setCurrentTrackIndex(0);
      } else {
        setIsPlaying(false);
        if (isRendering) {
          stopRenderingAndDownload();
        }
      }
    }
  };

  // Sync Audio Element
  useEffect(() => {
    if (audioRef.current && playlist.length > 0) {
      const newUrl = URL.createObjectURL(playlist[currentTrackIndex].file);
      audioRef.current.src = newUrl;
      
      if (isPlaying) {
        audioRef.current.play().catch(e => console.error("Play error", e));
      }
      
      return () => {
        URL.revokeObjectURL(newUrl);
      };
    }
  }, [currentTrackIndex, currentLoopIteration, playlist]);

  // Update Progress during Render
  useEffect(() => {
    let interval: number;
    if (isRendering && audioRef.current) {
      interval = window.setInterval(() => {
        let elapsed = 0;
        elapsed += currentLoopIteration * playlistDuration;
        for (let i = 0; i < currentTrackIndex; i++) {
          elapsed += playlist[i].duration;
        }
        elapsed += audioRef.current?.currentTime || 0;

        const progress = Math.min((elapsed / totalDuration) * 100, 99.9);
        setRenderProgress(progress);
      }, 200);
    }
    return () => clearInterval(interval);
  }, [isRendering, currentLoopIteration, currentTrackIndex, playlistDuration, totalDuration]);

  // Playlist Management
  const removeTrack = (id: string) => {
    setPlaylist(prev => prev.filter(t => t.id !== id));
  };

  const moveTrack = (index: number, direction: 'up' | 'down') => {
    if ((direction === 'up' && index === 0) || (direction === 'down' && index === playlist.length - 1)) return;
    const newPlaylist = [...playlist];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    [newPlaylist[index], newPlaylist[targetIndex]] = [newPlaylist[targetIndex], newPlaylist[index]];
    setPlaylist(newPlaylist);
  };

  // --- Rendering Logic ---

  const initiateRender = () => {
    setIsPlaying(false);
    audioRef.current?.pause();
    setShowRenderModal(true);
  };

  const startRendering = async () => {
    if (!canvasRef.current || !destNodeRef.current || !audioRef.current) return;
    
    // Check API Support
    if (!('showSaveFilePicker' in window)) {
        alert("⛔ 브라우저 미지원: Chrome이나 Edge 최신 버전을 사용해주세요.");
        return;
    }

    let writable: any = null;

    try {
        const handle = await (window as any).showSaveFilePicker({
            suggestedName: `${renderFilename.replace(/[^a-z0-9]/gi, '_')}.mp4`,
            types: [{
                description: 'Video File',
                accept: { 'video/mp4': ['.mp4'] },
            }],
        });
        writable = await handle.createWritable();

    } catch (err: any) {
        if (err.name === 'AbortError') return;
        console.error("File System Access Error:", err);
        alert(`⚠️ 저장 위치 선택 오류: ${err.message}`);
        return; 
    }

    if (!writable) return;

    setShowRenderModal(false);
    setIsRendering(true);
    setRenderProgress(0);
    setRenderStatusText("안정 모드 렌더링 중...");
    
    // Set Refs
    writableStreamRef.current = writable;
    writeQueueRef.current = Promise.resolve();

    // Reset playback position
    setCurrentTrackIndex(0);
    setCurrentLoopIteration(0);
    audioRef.current.currentTime = 0;

    // Mute Speakers
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.setValueAtTime(0, audioContextRef.current?.currentTime || 0);
    }

    // Capture Streams - KEY CHANGE: Use selected preset FPS
    const fps = selectedPreset.fps;
    const canvasStream = canvasRef.current.captureStream(fps); 
    const audioStream = destNodeRef.current.stream;
    const combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioStream.getAudioTracks()]);

    let mimeType = '';
    const supportedTypes = [
        'video/mp4; codecs="avc1.4d002a, mp4a.40.2"',
        'video/mp4; codecs="avc1.42002a, mp4a.40.2"',
        'video/mp4',
        'video/webm; codecs=h264',
    ];

    for (const type of supportedTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
            mimeType = type;
            break;
        }
    }

    if (!mimeType) mimeType = 'video/webm; codecs=vp9'; 

    try {
      mediaRecorderRef.current = new MediaRecorder(combinedStream, {
        mimeType,
        audioBitsPerSecond: encodingSettings.audioBitrate || 128000, 
        videoBitsPerSecond: selectedPreset.bitrate // Use selected bitrate
      });
    } catch (e) {
      console.warn("Recorder init failed", e);
      alert("녹화 초기화 실패.");
      setIsRendering(false);
      return;
    }

    mediaRecorderRef.current.ondataavailable = async (e) => {
      if (e.data.size > 0 && writableStreamRef.current) {
          const blob = e.data;
          writeQueueRef.current = writeQueueRef.current.then(async () => {
              try {
                  if (writableStreamRef.current) {
                      await writableStreamRef.current.write(blob);
                  }
              } catch (writeErr) {
                  console.error("Stream write error", writeErr);
              }
          });
      }
    };

    mediaRecorderRef.current.onstop = async () => {
        setRenderStatusText("파일 저장 마무리 중...");
        setRenderProgress(100);

        if (writableStreamRef.current) {
             try {
                 await writeQueueRef.current; 
                 await writableStreamRef.current.close();
                 alert(`✅ 저장 완료!\n\n${renderFilename}.mp4 파일이 정상적으로 저장되었습니다.`);
             } catch(e) { 
                 alert("파일 저장 마무리 중 오류가 발생했습니다.");
             }
        }
        
        setIsRendering(false);
        setIsPlaying(false);
        setRenderProgress(0);
        
        if (gainNodeRef.current) {
            gainNodeRef.current.gain.setValueAtTime(1, audioContextRef.current?.currentTime || 0);
        }
    };

    mediaRecorderRef.current.start(1000); 
    setIsPlaying(true);
    audioRef.current.play();
  };

  const stopRenderingAndDownload = () => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') return;
    mediaRecorderRef.current.stop();
    audioRef.current?.pause();
  };

  const cancelRendering = async () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    
    if (writableStreamRef.current) {
        try { await writableStreamRef.current.abort(); } catch(e) {}
    }

    setIsRendering(false);
    setIsPlaying(false);
    audioRef.current?.pause();
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.setValueAtTime(1, audioContextRef.current?.currentTime || 0);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 overflow-hidden font-sans relative">
      
      {/* 1. Filename & Quality Modal */}
      {showRenderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="bg-gray-800 p-8 rounded-2xl border border-gray-700 shadow-2xl w-full max-w-lg animate-fadeIn">
             <h2 className="text-2xl font-bold text-cyan-400 mb-6 flex items-center gap-2">
                <Film size={28}/> 영상 출력 설정
             </h2>
             
             <div className="space-y-6">
                 {/* Filename Input */}
                 <div>
                     <label className="block text-sm text-gray-400 mb-2">파일 이름</label>
                     <input 
                        type="text" 
                        value={renderFilename}
                        onChange={(e) => setRenderFilename(e.target.value)}
                        className="w-full bg-gray-900 border border-gray-600 rounded-lg p-3 text-white focus:border-cyan-500 outline-none"
                        placeholder="My_Spectrum_Video"
                     />
                 </div>

                 {/* Quality Selector */}
                 <div>
                    <label className="block text-sm text-gray-400 mb-2 flex items-center gap-2">
                        <Gauge size={16}/> 렌더링 품질 (멈춤 방지)
                    </label>
                    <div className="grid grid-cols-1 gap-3">
                        {RENDER_PRESETS.map((preset) => (
                            <button
                                key={preset.id}
                                onClick={() => setSelectedPreset(preset)}
                                className={`flex items-center justify-between p-3 rounded-lg border text-left transition-all ${
                                    selectedPreset.id === preset.id 
                                    ? 'bg-cyan-900/40 border-cyan-500 ring-1 ring-cyan-500' 
                                    : 'bg-gray-700/50 border-gray-600 hover:bg-gray-700'
                                }`}
                            >
                                <div>
                                    <div className={`font-bold text-sm ${selectedPreset.id === preset.id ? 'text-cyan-300' : 'text-gray-200'}`}>
                                        {preset.label}
                                    </div>
                                    <div className="text-xs text-gray-400 mt-0.5">{preset.description}</div>
                                </div>
                                <div className="text-xs font-mono text-gray-500 bg-black/20 px-2 py-1 rounded">
                                    {(preset.bitrate / 1000000).toFixed(1)}Mbps
                                </div>
                            </button>
                        ))}
                    </div>
                 </div>

                 <div className="p-4 bg-gray-900/50 rounded-lg text-xs text-gray-400 border border-gray-700">
                    <p className="mb-2 text-cyan-400 font-bold">📢 렌더링 팁</p>
                    <ul className="list-disc list-inside space-y-1">
                        <li><strong>'일반 (30fps)'</strong> 설정을 권장합니다. 60fps는 부하가 큽니다.</li>
                        <li>탐색기 창이 뜨면 저장할 위치를 지정해야 시작됩니다.</li>
                        <li className="text-red-400">렌더링 중 브라우저 탭을 닫거나 최소화하지 마세요.</li>
                    </ul>
                 </div>

                 <div className="flex gap-3 pt-2">
                     <button 
                        onClick={() => setShowRenderModal(false)}
                        className="flex-1 py-3 rounded-lg border border-gray-600 hover:bg-gray-700 text-gray-300"
                     >
                        취소
                     </button>
                     <button 
                        onClick={startRendering}
                        className="flex-1 py-3 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold shadow-lg transition-transform transform active:scale-95"
                     >
                        렌더링 시작
                     </button>
                 </div>
             </div>
          </div>
        </div>
      )}

      {/* 2. Rendering Progress Overlay */}
      {isRendering && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/95 backdrop-blur-md">
           <div className="w-full max-w-2xl px-8 text-center space-y-8">
               <div className="relative inline-block">
                   <div className="absolute inset-0 bg-cyan-500 blur-3xl opacity-20 rounded-full"></div>
                   <Activity size={80} className="text-cyan-400 relative z-10 animate-pulse" />
               </div>
               
               <div>
                   <h2 className="text-4xl font-black text-white mb-2 tracking-tight">{renderStatusText}</h2>
                   <p className="text-gray-400 text-lg">{renderFilename}.mp4</p>
               </div>

               <div className="relative pt-4">
                   <div className="flex justify-between text-sm font-bold mb-2">
                       <span className="text-cyan-400">진행률</span>
                       <span className="text-white">{renderProgress.toFixed(1)}%</span>
                   </div>
                   <div className="h-4 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
                       <div 
                          className="h-full bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-500 transition-all duration-300 ease-out"
                          style={{ width: `${renderProgress}%` }}
                       />
                   </div>
                   <p className="text-xs text-gray-500 mt-4 animate-pulse">
                        {selectedPreset.label} 모드 동작 중<br/>
                        <span className="text-red-500 font-bold">주의: 브라우저 창을 닫거나 최소화하지 마세요.</span>
                   </p>
               </div>

               <button 
                  onClick={cancelRendering}
                  className="mt-8 px-6 py-2 rounded-full border border-red-900/50 text-red-500 hover:bg-red-900/20 text-sm transition-colors"
               >
                  렌더링 취소
               </button>
           </div>
        </div>
      )}

      {/* Top Header */}
      <div className="h-14 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-6 shrink-0 z-20">
        <button onClick={onBack} disabled={isRendering} className="text-gray-400 hover:text-white flex items-center gap-2 transition-colors disabled:opacity-50">
          ← Back
        </button>
        <div className="flex items-center gap-6">
             <button onClick={initiateRender} className="bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-1.5 rounded-lg text-sm font-bold shadow-lg flex items-center gap-2 transition-all">
               <Download size={16} /> Render Video
             </button>
        </div>
      </div>

      {/* Main 3-Column Layout */}
      <div className="flex-1 grid grid-cols-12 overflow-hidden">
        
        {/* LEFT COLUMN: Visual Styles & Effects (Col-3) */}
        <div className="col-span-3 bg-gray-900 border-r border-gray-800 overflow-y-auto custom-scrollbar flex flex-col">
            <div className="p-4 space-y-8">
                {/* 1. Visual Style */}
                <section>
                    <h3 className="text-cyan-400 text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-2">
                        <Wand2 size={14} /> Visual Style
                    </h3>
                    <div className="grid grid-cols-2 gap-2">
                        {[
                            {id: 'none', label: '미적용'},
                            {id: 'bar', label: '막대형'},
                            {id: 'mirror-bar', label: '위-아래 막대'},
                            {id: 'mini-bar', label: '로고 옆 (6밴드)'},
                            {id: 'circle', label: '원형'},
                            {id: 'line', label: '선형'},
                            {id: 'wave', label: '파형 (3 Lines)'},
                        ].map((opt) => (
                            <button
                                key={opt.id}
                                onClick={() => updateSetting('spectrumStyle', opt.id as SpectrumStyle)}
                                className={`py-2 px-2 rounded text-xs border transition-all ${settings.spectrumStyle === opt.id ? 'bg-cyan-900/50 border-cyan-500 text-cyan-100' : 'bg-gray-800 border-gray-700 hover:bg-gray-700 text-gray-400'}`}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                </section>

                {/* 2. Background Filter */}
                <section>
                    <h3 className="text-cyan-400 text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-2">
                        <ImageIcon size={14} /> Background Filters
                    </h3>
                    <div className="grid grid-cols-3 gap-2 mb-4">
                        {['original', 'cinematic', 'vintage', 'noir', 'dreamy', 'vivid'].map((f) => (
                            <button
                                key={f}
                                onClick={() => updateSetting('filterPreset', f as FilterPreset)}
                                className={`py-2 rounded text-xs capitalize border ${settings.filterPreset === f ? 'bg-purple-900/50 border-purple-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400'}`}
                            >
                                {f}
                            </button>
                        ))}
                    </div>
                    <div className="space-y-4">
                        <div>
                            <div className="flex justify-between text-xs text-gray-400 mb-1">
                                <span>필터 강도</span> <span>{Math.round(settings.filterIntensity * 100)}%</span>
                            </div>
                            <input 
                                type="range" min="0" max="1" step="0.05"
                                value={settings.filterIntensity}
                                onChange={(e) => updateSetting('filterIntensity', parseFloat(e.target.value))}
                                className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                            />
                        </div>
                        <div>
                            <div className="flex justify-between text-xs text-gray-400 mb-1">
                                <span>비네팅 세기</span> <span>{Math.round(settings.vignette * 100)}%</span>
                            </div>
                            <input 
                                type="range" min="0" max="1" step="0.05"
                                value={settings.vignette}
                                onChange={(e) => updateSetting('vignette', parseFloat(e.target.value))}
                                className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                            />
                        </div>
                    </div>
                </section>

                {/* 3. Particle Effects */}
                <section>
                    <h3 className="text-cyan-400 text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-2">
                        <Settings size={14} /> Special Particles
                    </h3>
                    <div className="grid grid-cols-3 gap-2 mb-4">
                         {[
                            {id: 'none', icon: <X size={14}/>, label: '없음'},
                            {id: 'rain', icon: <ImageIcon size={14}/>, label: 'Rain'},
                            {id: 'snow', icon: <CloudSnow size={14}/>, label: 'Snow'},
                            {id: 'fog', icon: <CloudFog size={14}/>, label: 'Fog'},
                            {id: 'sparkle', icon: <Wand2 size={14}/>, label: 'Sparkle'},
                            {id: 'dust', icon: <Sun size={14}/>, label: 'Dust'},
                            {id: 'heart', icon: <Heart size={14}/>, label: 'Heart'},
                            {id: 'embers', icon: <Flame size={14}/>, label: 'Embers'},
                            {id: 'fireflies', icon: <Zap size={14}/>, label: 'Firefly'},
                            {id: 'petals', icon: <Flower2 size={14}/>, label: 'Petals'},
                            {id: 'bokeh', icon: <Sun size={14}/>, label: 'Bokeh'},
                            {id: 'confetti', icon: <PartyPopper size={14}/>, label: 'Confetti'},
                        ].map((opt) => (
                            <button
                                key={opt.id}
                                title={opt.label}
                                onClick={() => updateSetting('particleEffect', opt.id as ParticleEffect)}
                                className={`flex flex-col items-center justify-center p-2 rounded border gap-1 transition-all ${settings.particleEffect === opt.id ? 'bg-pink-900/50 border-pink-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                            >
                                {opt.icon}
                                <span className="text-[9px]">{opt.label}</span>
                            </button>
                        ))}
                    </div>
                    
                    {settings.particleEffect !== 'none' && (
                        <div className="space-y-3 bg-gray-800/50 p-3 rounded-lg border border-gray-700">
                             {[
                                 { label: '밀도', key: 'particleDensity', min: 10, max: 200 },
                                 { label: '투명도', key: 'particleOpacity', min: 0.1, max: 1, step: 0.1 },
                                 { label: '속도', key: 'particleSpeed', min: 0.1, max: 5, step: 0.1 },
                                 { label: '크기', key: 'particleSize', min: 1, max: 10, step: 0.5 },
                             ].map((ctrl) => (
                                 <div key={ctrl.key}>
                                     <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                                         <span>{ctrl.label}</span>
                                     </div>
                                     <input 
                                        type="range" min={ctrl.min} max={ctrl.max} step={ctrl.step || 1}
                                        value={settings[ctrl.key as keyof VisualSettings] as number}
                                        onChange={(e) => updateSetting(ctrl.key as keyof VisualSettings, parseFloat(e.target.value))}
                                        className="w-full h-1 bg-gray-700 rounded appearance-none cursor-pointer accent-pink-500"
                                     />
                                 </div>
                             ))}
                             
                             <div>
                                 <label className="block text-[10px] text-gray-400 mb-2">효과 컬러</label>
                                 <div className="flex flex-col gap-3">
                                     {/* Rainbow Mode & Manual Input */}
                                     <div className="flex items-center gap-2">
                                         {/* Rainbow Toggle */}
                                         <button
                                            title="Rainbow Mode"
                                            onClick={() => updateSetting('particleColorMode', settings.particleColorMode === 'rainbow' ? 'fixed' : 'rainbow')}
                                            className={`relative w-10 h-10 shrink-0 rounded-full overflow-hidden border-2 transition-transform hover:scale-105 ${settings.particleColorMode === 'rainbow' ? 'border-white scale-110 shadow-[0_0_10px_white]' : 'border-gray-600'}`}
                                         >
                                             <div className="absolute inset-0 bg-[conic-gradient(from_90deg,red,yellow,lime,aqua,blue,magenta,red)]" />
                                             {settings.particleColorMode === 'rainbow' && (
                                                 <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
                                                     <Check size={16} className="text-white drop-shadow-md" strokeWidth={3} />
                                                 </div>
                                             )}
                                         </button>
                                         
                                         {/* Hex Input */}
                                         <div className="flex-1 flex items-center gap-2 bg-gray-800 border border-gray-600 rounded-lg p-1 pl-3 h-10">
                                             <span className="text-xs text-gray-400">#</span>
                                             <input 
                                                 type="text" 
                                                 value={settings.particleColor.replace('#', '')}
                                                 onChange={(e) => {
                                                     let val = e.target.value;
                                                     // Allow partial input for typing hex
                                                     updateSetting('particleColor', val.startsWith('#') ? val : '#' + val);
                                                     updateSetting('particleColorMode', 'fixed');
                                                 }}
                                                 className="flex-1 bg-transparent text-sm text-white outline-none uppercase font-mono w-full"
                                                 maxLength={7}
                                             />
                                             {/* Color Preview Box inside Input */}
                                             <div className="relative w-8 h-8 rounded border border-gray-500 overflow-hidden cursor-pointer hover:border-white">
                                                 <div className="absolute inset-0" style={{backgroundColor: settings.particleColor}} />
                                                 <input 
                                                    type="color"
                                                    value={settings.particleColor}
                                                    onChange={(e) => {
                                                        updateSetting('particleColor', e.target.value);
                                                        updateSetting('particleColorMode', 'fixed');
                                                    }}
                                                    className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                                 />
                                             </div>
                                         </div>
                                     </div>

                                     {/* Presets */}
                                     <div className="grid grid-cols-8 gap-2">
                                         {PALETTE_COLORS.map(c => (
                                             <button 
                                                key={c}
                                                style={{backgroundColor: c}}
                                                onClick={() => {
                                                    updateSetting('particleColor', c);
                                                    updateSetting('particleColorMode', 'fixed');
                                                }}
                                                className={`w-6 h-6 rounded-full border border-gray-600 hover:scale-110 transition-transform ${settings.particleColor === c && settings.particleColorMode === 'fixed' ? 'ring-2 ring-white scale-110' : ''}`}
                                             />
                                         ))}
                                     </div>
                                 </div>
                             </div>
                        </div>
                    )}
                </section>

                {/* 4. Screen Effects (Post Processing) */}
                <section>
                    <h3 className="text-cyan-400 text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-2">
                        <Activity size={14} /> Screen Effects (FX)
                    </h3>
                    <div className="grid grid-cols-3 gap-2 mb-4">
                         {[
                            {id: 'none', icon: <X size={14}/>, label: 'None'},
                            {id: 'light-leak', icon: <Sunrise size={14}/>, label: 'Leaks'},
                            {id: 'lens-flare', icon: <Camera size={14}/>, label: 'Flare'},
                            {id: 'light-sweep', icon: <ScanLine size={14}/>, label: 'Sweep'},
                            {id: 'glitch', icon: <Activity size={14}/>, label: 'Glitch'},
                            {id: 'grain', icon: <Film size={14}/>, label: 'Grain'},
                            {id: 'bloom', icon: <Sun size={14}/>, label: 'Bloom'},
                            {id: 'vhs', icon: <Layout size={14}/>, label: 'VHS'},
                        ].map((opt) => (
                            <button
                                key={opt.id}
                                onClick={() => updateSetting('screenEffect', opt.id as ScreenEffect)}
                                className={`flex flex-col items-center justify-center p-2 rounded border gap-1 transition-all ${settings.screenEffect === opt.id ? 'bg-indigo-900/50 border-indigo-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                            >
                                {opt.icon}
                                <span className="text-[9px]">{opt.label}</span>
                            </button>
                        ))}
                    </div>
                    {settings.screenEffect !== 'none' && (
                         <div className="bg-gray-800 p-3 rounded-lg border border-gray-700">
                             <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                                 <span>FX Intensity</span>
                                 <span>{Math.round(settings.screenEffectIntensity * 100)}%</span>
                             </div>
                             <input 
                                type="range" min="0" max="1" step="0.05"
                                value={settings.screenEffectIntensity}
                                onChange={(e) => updateSetting('screenEffectIntensity', parseFloat(e.target.value))}
                                className="w-full h-1 bg-gray-700 rounded appearance-none cursor-pointer accent-indigo-500"
                            />
                         </div>
                    )}
                </section>
            </div>
        </div>

        {/* MIDDLE COLUMN: Preview & Playlist (Col-6) */}
        <div className="col-span-6 flex flex-col bg-black relative">
            {/* 1. Preview Area */}
            <div className="flex-1 flex items-center justify-center p-6 bg-gray-950 relative overflow-hidden">
                 <div className="relative shadow-2xl border border-gray-800 w-full max-w-[100%]" style={{ aspectRatio: '16/9' }}>
                    <VisualizerCanvas 
                        ref={canvasRef}
                        analyser={analyser}
                        settings={settings}
                        width={1280}
                        height={720}
                        isPlaying={isPlaying}
                        isRendering={isRendering}
                        fps={selectedPreset.fps}
                    />
                    
                    {/* Centered Play Button Overlay */}
                    {!isRendering && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <button 
                            onClick={handlePlayPause}
                            className={`pointer-events-auto transform transition-all duration-300 ${isPlaying ? 'opacity-0 hover:opacity-100' : 'opacity-100'} bg-black/50 hover:bg-black/70 rounded-full p-4 backdrop-blur-sm border border-white/20`}
                        >
                            {isPlaying ? <Pause size={48} className="text-white"/> : <Play size={48} className="text-white ml-2"/>}
                        </button>
                    </div>
                    )}
                 </div>
            </div>

            {/* 2. Playlist Editor (Bottom Panel) */}
            <div className="h-64 bg-gray-900 border-t border-gray-800 flex flex-col">
                <div className="p-3 border-b border-gray-800 flex justify-between items-center bg-gray-800">
                    <h3 className="text-sm font-bold text-gray-300 flex items-center gap-2">
                        <Layers size={14} /> Playlist Editor
                    </h3>
                    <span className="text-xs text-gray-500">{playlist.length} Tracks</span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {playlist.map((track, idx) => (
                        <div 
                            key={track.id} 
                            onClick={() => playTrack(idx)}
                            className={`flex items-center gap-3 p-2 rounded text-sm cursor-pointer transition-colors ${idx === currentTrackIndex ? 'bg-cyan-900/30 border border-cyan-800' : 'bg-gray-800/50 hover:bg-gray-800 border border-transparent'}`}
                        >
                             <span className={`w-6 text-center text-xs ${idx === currentTrackIndex ? 'text-cyan-400 font-bold' : 'text-gray-500'}`}>{idx + 1}</span>
                             <div className="flex-1 truncate">
                                 <span className={idx === currentTrackIndex ? 'text-white' : 'text-gray-300'}>{track.name}</span>
                             </div>
                             <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                <button onClick={() => moveTrack(idx, 'up')} className="p-1 hover:text-cyan-400 text-gray-500"><ArrowUp size={14}/></button>
                                <button onClick={() => moveTrack(idx, 'down')} className="p-1 hover:text-cyan-400 text-gray-500"><ArrowDown size={14}/></button>
                                <button onClick={() => removeTrack(track.id)} className="p-1 hover:text-red-400 text-gray-500"><Trash2 size={12}/></button>
                             </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>

        {/* RIGHT COLUMN: Layout & Fine-tuning (Col-3) */}
        <div className="col-span-3 bg-gray-900 border-l border-gray-800 overflow-y-auto custom-scrollbar">
             <div className="p-4 space-y-8">
                 
                 {/* 1. Channel Logo Layout */}
                 <section>
                     <h3 className="text-cyan-400 text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-2">
                         <Layout size={14} /> Logo Layout
                     </h3>
                     {settings.logoImage ? (
                         <div className="space-y-4 bg-gray-800 p-3 rounded-lg border border-gray-700">
                             <div className="grid grid-cols-2 gap-4">
                                 <div>
                                     <label className="text-[10px] text-gray-400 block mb-1">Pos X</label>
                                     <input 
                                        type="range" min="0" max="100" 
                                        value={settings.logoPosition.x}
                                        onChange={(e) => updateSetting('logoPosition', {...settings.logoPosition, x: parseFloat(e.target.value)})}
                                        className="w-full accent-cyan-500 h-1 bg-gray-700 rounded"
                                     />
                                 </div>
                                 <div>
                                     <label className="text-[10px] text-gray-400 block mb-1">Pos Y</label>
                                     <input 
                                        type="range" min="0" max="100" 
                                        value={settings.logoPosition.y}
                                        onChange={(e) => updateSetting('logoPosition', {...settings.logoPosition, y: parseFloat(e.target.value)})}
                                        className="w-full accent-cyan-500 h-1 bg-gray-700 rounded"
                                     />
                                 </div>
                             </div>
                             <div>
                                 <label className="text-[10px] text-gray-400 block mb-1">Size ({settings.logoSize}%)</label>
                                 <input 
                                    type="range" min="5" max="50" 
                                    value={settings.logoSize}
                                    onChange={(e) => updateSetting('logoSize', parseFloat(e.target.value))}
                                    className="w-full accent-cyan-500 h-1 bg-gray-700 rounded"
                                 />
                             </div>
                             <div className="flex items-center gap-2 pt-2 border-t border-gray-700">
                                 <input 
                                    type="checkbox" 
                                    checked={settings.logoRemoveBg}
                                    onChange={(e) => updateSetting('logoRemoveBg', e.target.checked)}
                                    className="rounded bg-gray-700 border-gray-600 text-cyan-600"
                                 />
                                 <span className="text-xs text-gray-300">배경 자동 제거</span>
                             </div>
                         </div>
                     ) : (
                         <div className="text-xs text-gray-500 italic p-2 text-center">No logo image selected</div>
                     )}
                 </section>

                 {/* 2. Spectrum Palette */}
                 <section>
                     <h3 className="text-cyan-400 text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-2">
                         <Palette size={14} /> 사용자 지정 컬러 팔레트
                     </h3>
                     
                     <div className="flex flex-col gap-3">
                         {/* Rainbow Mode & Manual Input */}
                         <div className="flex items-center gap-2">
                             {/* Rainbow Mode Toggle */}
                             <button
                                title="Rainbow Mode"
                                onClick={() => updateSetting('spectrumColorMode', settings.spectrumColorMode === 'rainbow' ? 'fixed' : 'rainbow')}
                                className={`relative w-10 h-10 rounded-full overflow-hidden border-2 transition-transform hover:scale-105 ${settings.spectrumColorMode === 'rainbow' ? 'border-white scale-110 shadow-[0_0_10px_white]' : 'border-gray-600'}`}
                             >
                                 <div className="absolute inset-0 bg-[conic-gradient(from_90deg,red,yellow,lime,aqua,blue,magenta,red)]" />
                                 {settings.spectrumColorMode === 'rainbow' && (
                                     <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
                                         <Check size={16} className="text-white drop-shadow-md" strokeWidth={3} />
                                     </div>
                                 )}
                             </button>
                             
                             {/* Manual Input + Color Picker */}
                             <div className="flex-1 flex items-center gap-2 bg-gray-800 border border-gray-600 rounded-lg p-1 pl-3 h-10">
                                 <span className="text-xs text-gray-400">#</span>
                                 <input 
                                     type="text" 
                                     value={settings.spectrumColor.replace('#', '')}
                                     onChange={(e) => {
                                         let val = e.target.value;
                                         if(!val.startsWith('#')) val = '#' + val;
                                         updateSetting('spectrumColor', val);
                                         updateSetting('spectrumColorMode', 'fixed');
                                     }}
                                     className="flex-1 bg-transparent text-sm text-white outline-none uppercase font-mono w-full"
                                     maxLength={7}
                                 />
                                 <div className="relative w-8 h-8 rounded border border-gray-500 overflow-hidden cursor-pointer hover:border-white">
                                     <div className="absolute inset-0" style={{backgroundColor: settings.spectrumColor}} />
                                     <input 
                                        type="color"
                                        value={settings.spectrumColor}
                                        onChange={(e) => {
                                            updateSetting('spectrumColor', e.target.value);
                                            updateSetting('spectrumColorMode', 'fixed');
                                        }}
                                        className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                     />
                                 </div>
                             </div>
                         </div>

                         {/* Preset Colors Grid */}
                         <div className="grid grid-cols-8 gap-2">
                             {PALETTE_COLORS.map(c => (
                                 <button 
                                    key={c}
                                    style={{backgroundColor: c}}
                                    onClick={() => {
                                        updateSetting('spectrumColor', c);
                                        updateSetting('spectrumColorMode', 'fixed');
                                    }}
                                    className={`w-6 h-6 rounded-full border border-gray-600 hover:scale-110 transition-transform ${settings.spectrumColor === c && settings.spectrumColorMode === 'fixed' ? 'ring-2 ring-white scale-110' : ''}`}
                                 />
                             ))}
                         </div>
                     </div>
                 </section>

                 {/* 3. Spectrum Layout & Details */}
                 <section>
                     <h3 className="text-cyan-400 text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-2">
                         <Sliders size={14} /> Spectrum Details
                     </h3>
                     
                     <div className="bg-gray-800 p-3 rounded-lg border border-gray-700 space-y-4">
                         
                         {/* Centering */}
                         <div className="flex items-center justify-between">
                             <span className="text-xs text-gray-300">정중앙 정렬</span>
                             <input 
                                type="checkbox"
                                checked={settings.spectrumCenter}
                                onChange={(e) => updateSetting('spectrumCenter', e.target.checked)}
                                className="toggle-checkbox"
                             />
                         </div>

                         {/* Position (Only if not centered) */}
                         {!settings.spectrumCenter && (
                            <div className="grid grid-cols-2 gap-2 animate-fadeIn">
                                <div>
                                    <label className="text-[10px] text-gray-500">Pos X</label>
                                    <input 
                                        type="range" min="0" max="100" 
                                        value={settings.spectrumPosition.x}
                                        onChange={(e) => updateSetting('spectrumPosition', {...settings.spectrumPosition, x: parseFloat(e.target.value)})}
                                        className="w-full h-1 bg-gray-700 accent-cyan-500 rounded"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] text-gray-500">Pos Y</label>
                                    <input 
                                        type="range" min="0" max="100" 
                                        value={settings.spectrumPosition.y}
                                        onChange={(e) => updateSetting('spectrumPosition', {...settings.spectrumPosition, y: parseFloat(e.target.value)})}
                                        className="w-full h-1 bg-gray-700 accent-cyan-500 rounded"
                                    />
                                </div>
                            </div>
                         )}

                         <hr className="border-gray-700"/>

                         {/* Details Sliders */}
                         {[
                             { label: '전체 폭 (Width)', key: 'spectrumWidth', min: 10, max: 100 },
                             { label: '막대 너비 (Bar Width)', key: 'barWidth', min: 1, max: 50 },
                             { label: '투명도 (Opacity)', key: 'spectrumOpacity', min: 0.1, max: 1, step: 0.1 },
                             { label: '반응 민감도', key: 'spectrumSensitivity', min: 0.1, max: 3, step: 0.1 },
                             { label: '주파수 대역 (Bars)', key: 'frequencyRange', min: 32, max: 256, step: 32 },
                             { label: '최대 높이', key: 'maxHeight', min: 0.5, max: 2, step: 0.1 },
                             { label: '선 두께', key: 'spectrumThickness', min: 1, max: 10 },
                         ].map(ctrl => (
                             <div key={ctrl.key}>
                                 <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                                     <span>{ctrl.label}</span>
                                     <span>{settings[ctrl.key as keyof VisualSettings] as number}</span>
                                 </div>
                                 <input 
                                    type="range" 
                                    min={ctrl.min} max={ctrl.max} step={ctrl.step || 1}
                                    value={settings[ctrl.key as keyof VisualSettings] as number}
                                    onChange={(e) => updateSetting(ctrl.key as keyof VisualSettings, parseFloat(e.target.value))}
                                    className="w-full h-1 bg-gray-700 accent-cyan-500 rounded appearance-none cursor-pointer"
                                 />
                             </div>
                         ))}
                     </div>
                 </section>

             </div>
        </div>
      </div>
      
      {/* Hidden Audio */}
      <audio 
        ref={audioRef}
        onEnded={handleTrackEnd}
        crossOrigin="anonymous"
      />
    </div>
  );
};