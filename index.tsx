import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import './index.css';

// Station Types
type Station = 'MERCH' | 'BEER' | 'TICKETS' | 'PRODUCTION' | 'COORDINATOR';
const GRID_STATIONS: Station[] = ['MERCH', 'BEER', 'TICKETS', 'PRODUCTION'];

interface Message {
  id: number;
  time: string;
  station: Station;
  text: string;
}

interface UserPresence {
  presence_ref: string;
  device_id: string;
  role: string;
  online_at: string;
}

const generateDeviceId = () => {
  let id = localStorage.getItem('derby_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('derby_device_id', id);
  }
  return id;
};

const BoutCoordinatorApp = () => {
  // --- STATE ---
  const [deviceId] = useState<string>(generateDeviceId());
  const [operatorName, setOperatorName] = useState(''); 
  
  // App Data
  const [doorCount, setDoorCount] = useState<number>(0);
  const [capacity, setCapacity] = useState<number>(300);
  const [messages, setMessages] = useState<Message[]>([]);
  
  // Input State
  const [inputText, setInputText] = useState('');
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);

  // Supabase State
  const [supabaseClient, setSupabaseClient] = useState<SupabaseClient | null>(null);
  const [channel, setChannel] = useState<RealtimeChannel | null>(null);
  const [configUrl, setConfigUrl] = useState('');
  const [configKey, setConfigKey] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [showNetworkModal, setShowNetworkModal] = useState<boolean>(false);
  const [connectionError, setConnectionError] = useState('');
  
  // WiFi State
  const [wifiSSID, setWifiSSID] = useState('');
  const [wifiPass, setWifiPass] = useState('');
  const [showWifiQr, setShowWifiQr] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  
  // Presence State
  const [otherCoordinatorOnline, setOtherCoordinatorOnline] = useState(false);

  // Reset State
  const [showResetView, setShowResetView] = useState(false);
  const [resetInputText, setResetInputText] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load Saved Role on Mount
  useEffect(() => {
    const savedRole = localStorage.getItem('derby_role');
    if (savedRole) {
      setOperatorName(savedRole);
    }
  }, []);

  // Persist Role Logic & Update Presence
  useEffect(() => {
    if (operatorName) {
      localStorage.setItem('derby_role', operatorName);
    } else {
      localStorage.removeItem('derby_role');
    }

    // Update Presence if connected
    if (channel) {
      channel.track({
        device_id: deviceId,
        role: operatorName,
        online_at: new Date().toISOString()
      });
    }
  }, [operatorName, channel, deviceId]);

  // Load credentials from Env or local storage on mount
  useEffect(() => {
    // 1. Defaults provided by user
    const DEFAULT_URL = 'https://rcfjdnzppdbrjjugzzza.supabase.co';
    const DEFAULT_KEY = 'sb_publishable_9VrqHhPhwkRDSS0YdVEUGg_m_lh9clC';

    let envUrl = DEFAULT_URL;
    let envKey = DEFAULT_KEY;

    // 2. Check for Environment Variables (Vercel/Build time overrides)
    try {
      if (typeof process !== 'undefined' && process.env) {
        if (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL) {
           envUrl = process.env.SUPABASE_URL || 
                    process.env.NEXT_PUBLIC_SUPABASE_URL || 
                    process.env.VITE_SUPABASE_URL || '';
        }
        
        if (process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_KEY) {
           envKey = process.env.SUPABASE_KEY || 
                    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 
                    process.env.VITE_SUPABASE_KEY || '';
        }
      }
    } catch (e) {
      // Ignore if process is not defined
    }

    if (envUrl && envKey) {
      setConfigUrl(envUrl);
      setConfigKey(envKey);
      connectToSupabase(envUrl, envKey);
    } else {
      const savedUrl = localStorage.getItem('supabase_url');
      const savedKey = localStorage.getItem('supabase_key');
      if (savedUrl && savedKey) {
        setConfigUrl(savedUrl);
        setConfigKey(savedKey);
        connectToSupabase(savedUrl, savedKey);
      } else {
        setShowNetworkModal(true); 
      }
    }
  }, []);

  // Generate QR Code when WiFi details change or modal opens
  useEffect(() => {
    if (showWifiQr && wifiSSID) {
      // WPA Format: WIFI:T:WPA;S:mynetwork;P:mypass;;
      const qrString = `WIFI:T:WPA;S:${wifiSSID};P:${wifiPass};;`;
      QRCode.toDataURL(qrString, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
        .then(url => {
          setQrDataUrl(url);
        })
        .catch(err => {
          console.error(err);
        });
    }
  }, [showWifiQr, wifiSSID, wifiPass]);

  // --- SUPABASE LOGIC ---

  const connectToSupabase = async (url: string, key: string) => {
    if (!url || !key) {
      setConnectionError('Please enter both URL and API Key');
      return;
    }

    try {
      const client = createClient(url, key);
      
      // 1. Initial Fetch
      const { data: stateData } = await client
        .from('event_state')
        .select('*')
        .eq('id', 'global_event')
        .single();
      
      if (stateData) {
        setDoorCount(stateData.door_count);
        setCapacity(stateData.capacity);
        if (stateData.wifi_ssid) setWifiSSID(stateData.wifi_ssid);
        if (stateData.wifi_pass) setWifiPass(stateData.wifi_pass);
      }

      // Fetch recent messages
      const { data: msgData } = await client
        .from('messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
        
      if (msgData) {
        setMessages(msgData.reverse() as any); 
      }

      // 2. Realtime Subscription (Data + Presence)
      const newChannel = client.channel('public:room', {
        config: {
          presence: {
            key: deviceId,
          },
        },
      });

      newChannel
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'event_state', filter: 'id=eq.global_event' },
          (payload) => {
            const newState = payload.new;
            setDoorCount(newState.door_count);
            setCapacity(newState.capacity);
            if (newState.wifi_ssid !== undefined) setWifiSSID(newState.wifi_ssid);
            if (newState.wifi_pass !== undefined) setWifiPass(newState.wifi_pass);
          }
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages' },
          (payload) => {
            const newMsg = payload.new as Message;
            setMessages(prev => [...prev, newMsg]);
          }
        )
        .on('presence', { event: 'sync' }, () => {
          const state = newChannel.presenceState();
          let bcFound = false;
          
          Object.values(state).forEach((presences: any) => {
            (presences as UserPresence[]).forEach(p => {
               // Check if someone ELSE is the coordinator
               if (p.role === 'COORDINATOR' && p.device_id !== deviceId) {
                 bcFound = true;
               }
            });
          });
          
          setOtherCoordinatorOnline(bcFound);
        })
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            setIsConnected(true);
            setSupabaseClient(client);
            setChannel(newChannel);
            setShowNetworkModal(false);
            setConnectionError('');
            
            // Track initial presence
            const currentRole = localStorage.getItem('derby_role') || '';
            await newChannel.track({
              device_id: deviceId,
              role: currentRole,
              online_at: new Date().toISOString()
            });

            if (!process.env?.SUPABASE_URL) {
                localStorage.setItem('supabase_url', url);
                localStorage.setItem('supabase_key', key);
            }
          }
        });

    } catch (err: any) {
      console.error(err);
      setConnectionError(err.message || 'Failed to connect. Check credentials.');
      setIsConnected(false);
    }
  };

  const disconnect = () => {
    if (supabaseClient) {
      supabaseClient.removeAllChannels();
    }
    setSupabaseClient(null);
    setChannel(null);
    setIsConnected(false);
    localStorage.removeItem('supabase_url');
    localStorage.removeItem('supabase_key');
    setMessages([]);
    setDoorCount(0);
  };

  // --- ACTIONS ---

  const handleDoorChange = async (delta: number) => {
    const newCount = Math.max(0, doorCount + delta);
    setDoorCount(newCount);

    if (supabaseClient) {
      await supabaseClient
        .from('event_state')
        .update({ door_count: newCount })
        .eq('id', 'global_event');
    }
  };

  const handleCapacityChange = async (newCap: number) => {
    setCapacity(newCap);

    if (supabaseClient) {
      await supabaseClient
        .from('event_state')
        .update({ capacity: newCap })
        .eq('id', 'global_event');
    }
  };

  const handleFullReset = async () => {
    if (resetInputText !== 'RESET') return;

    if (supabaseClient) {
      await supabaseClient
        .from('event_state')
        .update({ door_count: 0 })
        .eq('id', 'global_event');
      
      await supabaseClient
        .from('messages')
        .delete()
        .neq('id', -1);
    }

    setDoorCount(0);
    setMessages([]);
    
    setShowResetView(false);
    setResetInputText('');
    setShowNetworkModal(false);
  };

  const handleClaimBC = () => {
    setOperatorName('Bout Coordinator');
    setSelectedStation(null);
  };

  const handleRoleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const role = e.target.value;
    if (!role) return;

    if (role === 'COORDINATOR') {
      handleClaimBC();
    } else {
      setOperatorName(role);
      setSelectedStation(null);
    }
  };

  const handleRelease = () => {
    setOperatorName('');
    setSelectedStation(null);
  };

  const handleStationClick = (station: Station) => {
    if (operatorName === 'Bout Coordinator') {
      setSelectedStation(prev => prev === station ? null : station);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const hour12 = hours % 12 || 12; 
    const timeStr = `${hour12}:${minutes.toString().padStart(2, '0')} ${ampm}`;

    let sender: Station;
    if (operatorName === 'Bout Coordinator') {
        sender = selectedStation || 'COORDINATOR';
    } else {
        sender = operatorName as Station;
    }

    const newMessage = {
      time: timeStr,
      station: sender,
      text: inputText.trim()
    };

    setInputText('');

    if (supabaseClient) {
       await supabaseClient
        .from('messages')
        .insert([newMessage]);
    }
  };

  const handleWifiSave = async () => {
    if (supabaseClient) {
      // Save global WiFi settings to DB instead of local storage
      await supabaseClient
        .from('event_state')
        .update({ wifi_ssid: wifiSSID, wifi_pass: wifiPass })
        .eq('id', 'global_event');
    }
  };

  const getLastMessage = (station: Station) => {
    const stationMsgs = messages.filter(m => m.station === station);
    return stationMsgs.length > 0 ? stationMsgs[stationMsgs.length - 1] : null;
  };

  const occupancy = Math.min(100, Math.round((doorCount / (capacity || 1)) * 100));
  const isOverCapacity = doorCount > capacity;
  const isAssigned = operatorName.trim().length > 0;
  const isCoordinator = operatorName === 'Bout Coordinator';

  let currentSender = '';
  if (!isAssigned) {
    currentSender = 'ROLE';
  } else {
    currentSender = isCoordinator ? (selectedStation || 'COORDINATOR') : (operatorName as Station);
  }

  // --- RENDER ---
  return (
    <>
      <header>
        <div className="header-left">
          <div className="header-label">OPERATOR</div>
          {isAssigned ? (
            <div className="operator-display">
              <span className={`operator-badge badge-${operatorName === 'Bout Coordinator' ? 'coordinator' : operatorName.toLowerCase()}`}>
                {operatorName === 'Bout Coordinator' ? 'BC' : operatorName.substring(0,2)}
              </span>
              <span className="operator-name">{operatorName}</span>
              <button className="btn-release" onClick={handleRelease} title="Sign Off">✕</button>
            </div>
          ) : (
            <div className="operator-actions">
              <select className="role-select" onChange={handleRoleSelect} value="">
                <option value="" disabled>Select Role...</option>
                <option value="COORDINATOR" disabled={otherCoordinatorOnline}>
                  {otherCoordinatorOnline ? 'Bout Coordinator (Online)' : 'Bout Coordinator'}
                </option>
                <option disabled>──────</option>
                {GRID_STATIONS.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        
        <div className="header-right-group">
          {/* WIFI BUTTON */}
          <button 
            className="btn-network btn-wifi"
            onClick={() => setShowWifiQr(true)}
            title="Show WiFi QR Code"
          >
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.55a11 11 0 0 1 14.08 0"></path>
                <path d="M1.42 9a16 16 0 0 1 21.16 0"></path>
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
                <line x1="12" y1="20" x2="12.01" y2="20"></line>
              </svg>
          </button>

          <button 
            className={`btn-network ${isConnected ? 'client' : ''}`}
            onClick={() => setShowNetworkModal(true)}
          >
            <div className="net-icon"></div>
            <div className="net-status">
              {isConnected ? 'DB SYNC' : 'OFFLINE'}
            </div>
          </button>

          <div className={`header-status ${isAssigned ? 'status-active' : 'status-inactive'}`}>
            <span className="status-dot"></span>
            {isAssigned ? 'ONLINE' : 'OFF'}
          </div>
        </div>
      </header>

      {/* WIFI QR MODAL */}
      {showWifiQr && (
        <div className="modal-overlay">
          <div className="modal modal-wifi">
             <div className="modal-header">
              <span>VENUE WIFI ACCESS</span>
              <button className="btn-close" onClick={() => setShowWifiQr(false)}>✕</button>
            </div>
            <div className="modal-body wifi-body">
              {wifiSSID ? (
                <>
                  <div className="wifi-qr-container">
                    {qrDataUrl && <img src={qrDataUrl} alt="WiFi QR Code" className="qr-image" />}
                  </div>
                  <div className="wifi-details">
                    <div className="wifi-label">Network</div>
                    <div className="wifi-value">{wifiSSID}</div>
                    <div className="wifi-label">Password</div>
                    <div className="wifi-value">{wifiPass || '<No Password>'}</div>
                  </div>
                </>
              ) : (
                <div className="empty-log">
                  No WiFi configured. Click "DB SYNC" to set up venue WiFi details.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* CONNECTION CONFIG MODAL */}
      {showNetworkModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <span>SYSTEM CONFIGURATION</span>
              <button className="btn-close" onClick={() => setShowNetworkModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              
              {/* WIFI SECTION */}
              <div className="config-section">
                <div className="section-title">VENUE WIFI SETTINGS</div>
                <div className="input-group">
                  <label>SSID (Network Name)</label>
                  <input 
                    type="text" 
                    className="input-config" 
                    value={wifiSSID}
                    onChange={(e) => setWifiSSID(e.target.value)}
                    onBlur={handleWifiSave}
                    placeholder="e.g. RollerDerbyGuest"
                  />
                </div>
                 <div className="input-group">
                  <label>Password</label>
                  <input 
                    type="text" 
                    className="input-config" 
                    value={wifiPass}
                    onChange={(e) => setWifiPass(e.target.value)}
                    onBlur={handleWifiSave}
                    placeholder="WPA2 Password"
                  />
                </div>
              </div>

              {isConnected ? (
                <>
                  <div className="net-active-state">
                    <div className="active-title">CONNECTED TO SUPABASE</div>
                    <div className="active-info">Data syncing in real-time</div>
                    <div className="device-id-display">Device ID: {deviceId}</div>
                    <button className="btn-disconnect" onClick={disconnect}>DISCONNECT & CLEAR</button>
                  </div>
                  
                  {/* DANGER ZONE - RESET */}
                  <div className="danger-zone">
                    <div className="danger-title">Danger Zone</div>
                    {!showResetView ? (
                      <button className="btn-show-reset" onClick={() => setShowResetView(true)}>
                        RESET EVENT DATA
                      </button>
                    ) : (
                      <div className="reset-container">
                        <div className="net-desc" style={{marginBottom: '8px', color: 'var(--danger)', fontSize: '0.8rem'}}>
                          Type <strong>RESET</strong> to clear all messages and zero the counter.
                        </div>
                        <div className="reset-row">
                          <input 
                            type="text" 
                            className="input-danger"
                            placeholder="Type RESET"
                            value={resetInputText}
                            onChange={(e) => setResetInputText(e.target.value)}
                          />
                          <button 
                            className="btn-danger-confirm" 
                            disabled={resetInputText !== 'RESET'}
                            onClick={handleFullReset}
                          >
                            CONFIRM
                          </button>
                        </div>
                        <button 
                          className="btn-cancel-reset" 
                          onClick={() => { setShowResetView(false); setResetInputText(''); }}
                          style={{marginTop: '8px', width: '100%', background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer'}}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="net-section">
                   <div className="section-title">DATABASE CONNECTION</div>
                  <div className="net-desc">Enter your Supabase credentials to sync.</div>
                  <input 
                    type="text" 
                    placeholder="Project URL (https://...supabase.co)" 
                    value={configUrl}
                    onChange={(e) => setConfigUrl(e.target.value)}
                    className="input-config"
                  />
                  <input 
                    type="password" 
                    placeholder="API Key (public/anon)" 
                    value={configKey}
                    onChange={(e) => setConfigKey(e.target.value)}
                    className="input-config"
                  />
                  {connectionError && <div className="net-error">{connectionError}</div>}
                  <button className="btn-join" onClick={() => connectToSupabase(configUrl, configKey)}>
                    CONNECT DATABASE
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="main-content">
        
        {/* Module 1: Door Counter */}
        <div className="card counter-card">
          <div className="card-header">
            <span>Venue Capacity Control</span>
            <div className="capacity-input-wrapper">
              <label>Cap:</label>
              <input 
                type="number" 
                value={capacity} 
                onChange={(e) => handleCapacityChange(Math.max(1, parseInt(e.target.value) || 0))}
                className="capacity-input"
              />
            </div>
          </div>
          
          <div className="counter-body">
            <div className="progress-container">
              <div className="progress-labels">
                <span>Occupancy: {occupancy}%</span>
                <span className={isOverCapacity ? "text-danger" : ""}>
                  {doorCount} / {capacity}
                </span>
              </div>
              <div className="progress-track">
                <div 
                  className={`progress-fill ${isOverCapacity ? 'bg-danger' : ''}`}
                  style={{ width: `${occupancy}%` }}
                ></div>
              </div>
            </div>

            <div className="counter-controls">
              <button 
                className="btn btn-dec" 
                onClick={() => handleDoorChange(-1)}
              >
                -
              </button>
              
              <div className="count-display-large">
                {doorCount}
                <span className="count-label">ATTENDEES</span>
              </div>
              
              <button 
                className="btn btn-inc" 
                onClick={() => handleDoorChange(1)}
              >
                +
              </button>
            </div>
          </div>
        </div>

        {/* Module 2: Station Dashboard */}
        <div className="station-grid">
          {GRID_STATIONS.map(station => {
            const lastMsg = getLastMessage(station);
            const isSelected = isCoordinator && selectedStation === station;
            return (
              <div 
                key={station} 
                className={`card station-card station-${station.toLowerCase()} ${isSelected ? 'selected' : ''}`}
                onClick={() => handleStationClick(station)}
              >
                <div className="station-header">
                  <span className="station-name">{station}</span>
                  {lastMsg && <span className="station-time">{lastMsg.time}</span>}
                </div>
                <div className="station-body">
                  {lastMsg ? (
                    <div className="station-msg-text">"{lastMsg.text}"</div>
                  ) : (
                    <div className="station-empty">No activity</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Module 3: Input & Log */}
        <div className="card messages-card">
          <form className="input-area" onSubmit={handleSendMessage}>
            <div className={`input-row ${currentSender === 'COORDINATOR' ? 'mode-coordinator' : ''}`}>
              <div className={`selected-indicator badge-${currentSender.toLowerCase()} ${!isAssigned ? 'badge-none' : ''}`}>
                <span className="badge-label">{currentSender === 'COORDINATOR' ? 'COORDINATOR' : currentSender}</span>
                {isCoordinator && selectedStation && (
                  <button type="button" className="btn-clear-station" onClick={() => setSelectedStation(null)} title="Clear Selection">
                    ✕
                  </button>
                )}
              </div>
              <input 
                type="text"
                className="form-control input-text"
                placeholder={isAssigned ? (currentSender === 'COORDINATOR' ? "Broadcast to all stations..." : `Log message from ${currentSender}...`) : "Select role above to chat..."}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                disabled={!isAssigned}
              />
              <button type="submit" className="btn btn-send" disabled={!isAssigned}>
                SEND
              </button>
            </div>
          </form>

          <div className="message-list-compact">
            {messages.length === 0 && (
              <div className="empty-log">Event log is empty. Use the form above to log activity.</div>
            )}
            {messages.slice().map((msg, idx) => (
              <div key={idx} className={`compact-item ${msg.station === 'COORDINATOR' ? 'msg-coordinator' : ''}`}>
                <span className="compact-time">{msg.time}</span>
                <span className={`compact-badge badge-${msg.station.toLowerCase()}`}>
                  {msg.station === 'COORDINATOR' ? 'BC' : msg.station}
                </span>
                <span className="compact-text">{msg.text}</span>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

      </div>
    </>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<BoutCoordinatorApp />);