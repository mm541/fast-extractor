import React, { useState, useEffect, useCallback } from 'react';

// Inform TypeScript about the global google object loaded by the script
declare global {
    interface Window {
        google?: any;
    }
}

interface GoogleDriveDemoProps {
    onStreamReady: (stream: ReadableStream<Uint8Array>, filename: string) => void;
    onError: (err: string) => void;
    disabled?: boolean;
}

const GoogleDriveDemo: React.FC<GoogleDriveDemoProps> = ({ onStreamReady, onError, disabled }) => {
    const [clientId, setClientId] = useState(() => localStorage.getItem('gd_client_id') || '');
    const [fileUrl, setFileUrl] = useState('');
    const [isAuthorizing, setIsAuthorizing] = useState(false);
    const [gsiLoaded, setGsiLoaded] = useState(false);

    // Dynamic loading of the Google Identity Services script
    useEffect(() => {
        if (document.getElementById('google-gsi-script')) {
            setGsiLoaded(true);
            return;
        }
        
        const script = document.createElement('script');
        script.id = 'google-gsi-script';
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => setGsiLoaded(true);
        script.onerror = () => onError("Failed to load Google Identity Services.");
        document.body.appendChild(script);
    }, [onError]);

    // Save Client ID to local storage automatically so user doesn't paste it every time
    useEffect(() => {
        if (clientId) localStorage.setItem('gd_client_id', clientId);
    }, [clientId]);

    const extractFileId = (urlOrId: string): string | null => {
        const urlMatch = urlOrId.match(/[-\w]{25,}/);
        return urlMatch ? urlMatch[0] : null;
    };

    const handleAuthenticate = useCallback(() => {
        if (!clientId) {
            onError("Please provide a valid Google Cloud Client ID.");
            return;
        }

        const fileId = extractFileId(fileUrl);
        if (!fileId) {
            onError("Could not extract a valid Google Drive File ID from the input.");
            return;
        }

        if (!window.google?.accounts?.oauth2) {
            onError("Google Identity Services library is not ready yet.");
            return;
        }

        setIsAuthorizing(true);
        
        try {
            const tokenClient = window.google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                // We only need readonly access to Google Drive files
                scope: 'https://www.googleapis.com/auth/drive.readonly',
                callback: async (tokenResponse: any) => {
                    setIsAuthorizing(false);
                    
                    if (tokenResponse.error) {
                        onError("OAuth Error: " + tokenResponse.error);
                        return;
                    }

                    const token = tokenResponse.access_token;
                    
                    // Now that we have the secret OAuth token, fetch the raw stream
                    try {
                        // 1. Fetch file metadata just to get the name
                        const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name`, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        
                        let fileName = 'drive_stream.mp4';
                        if (metaRes.ok) {
                            const meta = await metaRes.json();
                            if (meta.name) fileName = meta.name;
                        }

                        // 2. Fetch the actual raw byte stream
                        const mediaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });

                        if (!mediaRes.ok) {
                            throw new Error(`Google API threw HTTP ${mediaRes.status}. Make sure the Google Drive API is enabled in your Google Cloud Console.`);
                        }

                        if (!mediaRes.body) {
                            throw new Error("No ReadableStream could be generated from the fetch response.");
                        }

                        // Pass the raw ReadableStream and filename up to App.tsx
                        onStreamReady(mediaRes.body, fileName);

                    } catch (err: any) {
                        onError("Fetch failed: " + err.message);
                    }
                },
                error_callback: (err: any) => {
                    setIsAuthorizing(false);
                    onError("Identity UI Error: " + JSON.stringify(err));
                }
            });

            // Trigger the Google popup
            tokenClient.requestAccessToken({ prompt: '' });
            
        } catch (err: any) {
            setIsAuthorizing(false);
            onError("Token generation failed: " + err.message);
        }

    }, [clientId, fileUrl, onError, onStreamReady]);

    return (
        <div style={{ backgroundColor: '#181818', padding: '16px', borderRadius: '8px', border: '1px solid #333' }}>
            <h3 style={{ marginTop: 0, color: '#e0e0e0', fontSize: '15px' }}>🔒 Personal Google Drive Picker</h3>
            <p style={{ fontSize: '12px', color: '#888', marginBottom: '16px' }}>
                Securely extract from your private Drive without downloading the file. 
                Requires a Google Cloud Web Client ID pointing to your localhost.
            </p>

            <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', color: '#aaa', marginBottom: '4px' }}>Google Cloud Client ID:</label>
                <input 
                    type="text" 
                    placeholder="Enter your ~70 character xxx.apps.googleusercontent.com ID..."
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    disabled={disabled}
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #444', backgroundColor: '#111', color: 'white', boxSizing: 'border-box' }}
                />
            </div>

            <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', color: '#aaa', marginBottom: '4px' }}>Drive File URL or ID:</label>
                <input 
                    type="text" 
                    placeholder="e.g. https://drive.google.com/file/d/1A2b3C.../view"
                    value={fileUrl}
                    onChange={(e) => setFileUrl(e.target.value)}
                    disabled={disabled}
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #444', backgroundColor: '#111', color: 'white', boxSizing: 'border-box' }}
                />
            </div>

            <button 
                onClick={handleAuthenticate}
                disabled={disabled || !gsiLoaded || !clientId || !fileUrl || isAuthorizing}
                style={{ 
                    width: '100%', 
                    padding: '10px', 
                    backgroundColor: isAuthorizing ? '#444' : '#4285F4', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: '4px',
                    cursor: (disabled || !gsiLoaded || isAuthorizing) ? 'not-allowed' : 'pointer',
                    fontWeight: 'bold'
                }}
            >
                {isAuthorizing ? '⏳ Requesting OAuth Token...' : (!gsiLoaded ? '⏳ Loading API...' : '🔐 Sign In & Fetch Stream')}
            </button>
        </div>
    );
};

export default GoogleDriveDemo;
