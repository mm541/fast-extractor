import React from 'react';
import type { SlideIndexEntry } from '../types';
import { formatMs } from '../utils';

interface LightboxProps {
    slides: SlideIndexEntry[];
    lightboxIndex: number;
    lightboxZoom: number;
    setLightboxIndex: (index: number | null) => void;
    setLightboxZoom: React.Dispatch<React.SetStateAction<number>>;
}

const Lightbox: React.FC<LightboxProps> = ({ slides, lightboxIndex, lightboxZoom, setLightboxIndex, setLightboxZoom }) => {
    return (
        <div className="lightbox-overlay" onClick={() => setLightboxIndex(null)}>
            <button className="lightbox-close" onClick={() => setLightboxIndex(null)}>&times;</button>
            {lightboxIndex > 0 && (
                <button className="lightbox-nav prev" onClick={(e) => { e.stopPropagation(); setLightboxZoom(1); setLightboxIndex(lightboxIndex - 1); }}>&#10094;</button>
            )}
            {lightboxIndex < slides.length - 1 && (
                <button className="lightbox-nav next" onClick={(e) => { e.stopPropagation(); setLightboxZoom(1); setLightboxIndex(lightboxIndex + 1); }}>&#10095;</button>
            )}
            <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
                <img 
                    src={slides[lightboxIndex].url} 
                    className="lightbox-img" 
                    style={{ transform: `scale(${lightboxZoom})` }}
                    onWheel={(e) => {
                        e.preventDefault();
                        const zoomFactor = Math.exp(-e.deltaY * 0.002);
                        setLightboxZoom(prev => Math.max(1, Math.min(prev * zoomFactor, 5)));
                    }}
                    alt="Slide larger view" 
                />
            </div>
            <div className="lightbox-info">
                {formatMs(Math.floor(slides[lightboxIndex].startMs / 1000) * 1000)}
            </div>
            <div className="lightbox-controls" onClick={(e) => e.stopPropagation()}>
                <button className="lightbox-btn" onClick={() => setLightboxZoom(prev => Math.max(1, prev - 0.5))}>⊖</button>
                <span style={{ color: 'white', lineHeight: '24px' }}>{Math.round(lightboxZoom * 100)}%</span>
                <button className="lightbox-btn" onClick={() => setLightboxZoom(prev => Math.min(5, prev + 0.5))}>⊕</button>
            </div>
        </div>
    );
};

export default Lightbox;
