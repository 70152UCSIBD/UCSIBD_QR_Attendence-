"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Html5Qrcode, Html5QrcodeScanner } from 'html5-qrcode';
import { supabase } from '../lib/supabaseClient';

const ALLOWED_EMAIL_DOMAIN = process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN || 'ucsi.edu.bd';
/** Proxied to `/.netlify/functions/*` via next.config.mjs */
const FUNCTIONS_BASE = process.env.NEXT_PUBLIC_NETLIFY_FUNCTIONS_BASE || '/netlify/functions';
const SESSION_CLOSE_MS =
  (parseInt(process.env.NEXT_PUBLIC_SESSION_CLOSE_MINUTES || '20', 10) || 20) * 60 * 1000;

export default function Home() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [otpInput, setOtpInput] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [qrCodeError, setQrCodeError] = useState('');
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [gpsCoords, setGpsCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [cameraPermissionGranted, setCameraPermissionGranted] = useState(false);
  /** Bumped after each successful scan so the scanner effect re-runs and mounts a new Html5QrcodeScanner. */
  const [scannerRemountKey, setScannerRemountKey] = useState(0);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualRoomCode, setManualRoomCode] = useState('');
  const [gpsConsentSigned, setGpsConsentSigned] = useState<boolean | null>(null);

  const qrCodeRef = useRef<Html5QrcodeScanner | null>(null);
  const sessionCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gpsCoordsRef = useRef(gpsCoords);
  useEffect(() => {
    gpsCoordsRef.current = gpsCoords;
  }, [gpsCoords]);

  // 1. Supabase Auth Listener
  useEffect(() => {
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      setIsAuthenticated(!!session);
      setUserEmail(session?.user?.email || null);
      if (session) {
        setStatusMessage('Logged in successfully!');
      } else {
        setStatusMessage('Logged out.');
      }
    });

    // Check initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setIsAuthenticated(!!session);
      setUserEmail(session?.user?.email || null);
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setGpsConsentSigned(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      const { data: profile } = await supabase
        .from('profiles')
        .select('gps_consent_signed')
        .eq('id', user.id)
        .single();
      if (!cancelled) {
        setGpsConsentSigned(profile?.gps_consent_signed ?? false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const clearSessionCloseTimer = useCallback(() => {
    if (sessionCloseTimerRef.current) {
      clearTimeout(sessionCloseTimerRef.current);
      sessionCloseTimerRef.current = null;
    }
  }, []);

  const scheduleSessionClosePing = useCallback((attendanceLogId: string) => {
    clearSessionCloseTimer();
    sessionCloseTimerRef.current = setTimeout(async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      try {
        await fetch(`${FUNCTIONS_BASE}/session-close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attendanceLogId, userId: user.id }),
        });
      } catch (e) {
        console.error('Session close ping failed:', e);
      }
    }, SESSION_CLOSE_MS);
  }, [clearSessionCloseTimer]);

  useEffect(() => {
    return () => clearSessionCloseTimer();
  }, [clearSessionCloseTimer]);

  // 2. Geolocation — only after v2 GPS consent (WiFi-only validation if declined)
  useEffect(() => {
    if (!isAuthenticated || !gpsConsentSigned) {
      return;
    }
    if (!navigator.geolocation) {
      setStatusMessage('Geolocation is not supported by your browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGpsCoords({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        setStatusMessage('GPS location obtained.');
      },
      (error) => {
        console.error('Geolocation error:', error);
        setStatusMessage(
          'Failed to get GPS location. You can still be validated on campus WiFi, or use manual room entry.'
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }, [isAuthenticated, gpsConsentSigned]);

  const sendAttendanceData = useCallback(async (qrData: string, type: 'qr_scan' | 'manual_entry') => {
    try {
      const user = await supabase.auth.getUser();
      if (!user.data.user) {
        setStatusMessage('Authentication required to send attendance.');
        return;
      }

      const payload = {
        qrToken: qrData,
        gpsData: gpsCoordsRef.current,
        userId: user.data.user.id,
        timestamp: new Date().toISOString(),
        isManualEntry: type === 'manual_entry',
      };

      const response = await fetch(`${FUNCTIONS_BASE}/validate-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();
      if (response.ok) {
        setStatusMessage(`Attendance recorded: ${result.message}`);
        if (typeof result.attendanceLogId === 'string') {
          scheduleSessionClosePing(result.attendanceLogId);
        }
      } else {
        setStatusMessage(`Attendance failed: ${result.error || 'Unknown error'}`);
      }
    } catch (error: any) {
      console.error('Error sending attendance data:', error);
      setStatusMessage(`Error sending attendance data: ${error.message}`);
    }
  }, [scheduleSessionClosePing]);

  // 3. QR Scanner Initialization
  useEffect(() => {
    if (isAuthenticated && !qrCodeRef.current) {
      qrCodeRef.current = new Html5QrcodeScanner(
        "reader",
        { fps: 10, qrbox: { width: 250, height: 250 }, rememberLastUsedCamera: true, disableFlip: false },
        false
      );

      const onScanSuccess = async (decodedText: string) => {
        setScanResult(decodedText);
        setQrCodeError('');
        setStatusMessage(`QR Scanned: ${decodedText}. Sending attendance...`);
        if (qrCodeRef.current) {
          qrCodeRef.current.clear().catch(error => console.error("Failed to clear scanner", error));
          qrCodeRef.current = null;
        }
        setScannerRemountKey((k) => k + 1);
        await sendAttendanceData(decodedText, 'qr_scan');
      };

      const onScanFailure = (error: string) => {
        setQrCodeError(`QR Scan Error: ${error}`);
      };

      // Request camera permission explicitly before starting the scanner (API lives on Html5Qrcode, not Html5QrcodeScanner)
      Html5Qrcode.getCameras()
        .then(cameras => {
          if (cameras && cameras.length) {
            setCameraPermissionGranted(true);
            qrCodeRef.current?.render(onScanSuccess, onScanFailure);
          } else {
            setCameraPermissionGranted(false);
            setStatusMessage('No camera found or permission denied. Please allow camera access to use the QR scanner.');
          }
        })
        .catch(err => {
          console.error('Error getting cameras:', err);
          setCameraPermissionGranted(false);
          setStatusMessage('Error accessing camera. Please ensure camera permissions are granted.');
        });
    }

    return () => {
      if (qrCodeRef.current) {
        qrCodeRef.current.clear().catch(error => console.error("Failed to clear scanner on cleanup", error));
        qrCodeRef.current = null;
      }
    };
  }, [isAuthenticated, sendAttendanceData, scannerRemountKey]);

  const handleAcceptGpsConsent = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setStatusMessage('Saving consent...');
    const { error } = await supabase
      .from('profiles')
      .update({
        gps_consent_signed: true,
        gps_consent_date: new Date().toISOString(),
      })
      .eq('id', user.id);
    if (error) {
      setStatusMessage(`Could not save consent: ${error.message}`);
      return;
    }
    setGpsConsentSigned(true);
    setStatusMessage('GPS consent saved.');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const domain = ALLOWED_EMAIL_DOMAIN.toLowerCase();
    const email = emailInput.trim().toLowerCase();
    if (!email.endsWith(`@${domain}`)) {
      setStatusMessage(`Only @${domain} university accounts are allowed.`);
      return;
    }
    setStatusMessage('Sending OTP...');
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: emailInput,
        options: {
          emailRedirectTo: window.location.origin, // Redirects back to the PWA after magic link if it was enabled, though we use OTP
          shouldCreateUser: true, // Allow new user creation if not existing
        },
      });

      if (error) {
        throw error;
      }
      setOtpSent(true);
      setStatusMessage('OTP sent to your email! Please check your inbox.');
    } catch (error: any) {
      console.error('Login error:', error.message);
      setStatusMessage(`Login failed: ${error.message}`);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage('Verifying OTP...');
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: emailInput,
        token: otpInput,
        type: 'email',
      });

      if (error) {
        throw error;
      }
      setOtpSent(false); // Reset OTP form
      setOtpInput(''); // Clear OTP input
      setStatusMessage('OTP verified. Logging in...');
    } catch (error: any) {
      console.error('OTP verification error:', error.message);
      setStatusMessage(`OTP verification failed: ${error.message}`);
    }
  };

  const handleLogout = async () => {
    setStatusMessage('Logging out...');
    clearSessionCloseTimer();
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        throw error;
      }
      setIsAuthenticated(false);
      setUserEmail(null);
      setScanResult(null);
      setQrCodeError('');
      setGpsCoords(null);
      setCameraPermissionGranted(false);
      setScannerRemountKey(0);
      if (qrCodeRef.current) {
        qrCodeRef.current.clear();
        qrCodeRef.current = null;
      }
      setStatusMessage('Successfully logged out.');
    } catch (error: any) {
      console.error('Logout error:', error.message);
      setStatusMessage(`Logout failed: ${error.message}`);
    }
  };

  const handleManualEntrySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualRoomCode) {
      setStatusMessage('Please enter a room code.');
      return;
    }
    setStatusMessage(`Manual entry for room code: ${manualRoomCode}. Sending attendance...`);
    await sendAttendanceData(manualRoomCode, 'manual_entry');
    setManualRoomCode('');
    setShowManualEntry(false);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-start p-6 bg-gray-100 text-gray-800">
      <div className="w-full max-w-xl bg-white shadow-lg rounded-lg p-6 sm:p-8 mt-8">
        <h1 className="text-3xl font-bold text-center mb-6 text-blue-700">Faculty Attendance</h1>

        <p className="text-center text-sm text-gray-600 mb-4">{statusMessage}</p>

        {!isAuthenticated ? (
          <div className="space-y-4">
            {!otpSent ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <input
                  type="email"
                  placeholder="University Email (@ucsi.edu.bd)"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
                <button
                  type="submit"
                  className="w-full bg-blue-600 text-white p-3 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  Send OTP
                </button>
              </form>
            ) : (
              <form onSubmit={handleVerifyOtp} className="space-y-4">
                <p className="text-center text-green-600">OTP sent to {userEmail || emailInput}.</p>
                <input
                  type="text"
                  placeholder="6-digit OTP"
                  value={otpInput}
                  onChange={(e) => setOtpInput(e.target.value)}
                  className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
                <button
                  type="submit"
                  className="w-full bg-green-600 text-white p-3 rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
                >
                  Verify OTP
                </button>
                <button
                  type="button"
                  onClick={() => setOtpSent(false)}
                  className="w-full text-blue-600 p-2 rounded-md hover:bg-blue-50 focus:outline-none"
                >
                  Change Email
                </button>
              </form>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <p className="text-center text-lg font-medium text-blue-600">Welcome, {userEmail}!</p>
            <button
              onClick={handleLogout}
              className="w-full bg-red-600 text-white p-3 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
            >
              Logout
            </button>

            {gpsConsentSigned === null && (
              <p className="text-center text-sm text-gray-500">Loading profile…</p>
            )}

            {gpsConsentSigned === false && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-3" role="region" aria-label="GPS consent">
                <p className="font-semibold text-amber-900">GPS data consent</p>
                <p className="text-sm text-amber-900/90">
                  Under university data governance (v2.0), location may be used for building geofence checks.
                  Without consent, validation uses campus WiFi only when you scan; GPS coordinates are not stored.
                </p>
                <button
                  type="button"
                  onClick={handleAcceptGpsConsent}
                  className="w-full bg-amber-600 text-white py-2.5 rounded-md hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 text-sm font-medium"
                >
                  I consent to GPS processing for attendance validation
                </button>
              </div>
            )}

            {gpsConsentSigned === true && (
              <p className="text-center text-xs text-gray-500">
                GPS consent on file — location is requested for geofence validation (you may still pass on campus WiFi only).
              </p>
            )}

            <h2 className="text-2xl font-semibold text-center mt-8 mb-4">Scan Attendance QR</h2>

            {!cameraPermissionGranted ? (
              <div className="bg-yellow-100 border-l-4 border-yellow-500 text-yellow-700 p-4" role="alert">
                <p className="font-bold">Camera Access Required</p>
                <p>Please grant camera permissions to use the QR scanner. If already granted, try refreshing the page.</p>
              </div>
            ) : (
              <>
                <div id="reader" className="w-full border border-gray-300 rounded-md overflow-hidden"></div>
                {qrCodeError && (
                  <p className="text-red-500 text-sm mt-2 text-center">{qrCodeError}</p>
                )}
                {scanResult && (
                  <p className="text-green-600 text-sm mt-2 text-center">Last Scan: {scanResult}</p>
                )}
              </>
            )}

            <div className="mt-8 text-center">
              <button
                onClick={() => setShowManualEntry(!showManualEntry)}
                className="bg-gray-200 text-gray-800 p-3 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2"
              >
                {showManualEntry ? 'Hide Manual Entry' : 'Enter Room Code Manually'}
              </button>
            </div>

            {showManualEntry && (
              <form onSubmit={handleManualEntrySubmit} className="space-y-4 mt-4 p-4 border border-dashed border-gray-300 rounded-md bg-gray-50">
                <p className="text-center font-semibold">Manual Attendance Entry</p>
                <input
                  type="text"
                  placeholder="Enter Room Code (e.g., C301)"
                  value={manualRoomCode}
                  onChange={(e) => setManualRoomCode(e.target.value)}
                  className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
                <button
                  type="submit"
                  className="w-full bg-blue-600 text-white p-3 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  Submit Manual Attendance
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
