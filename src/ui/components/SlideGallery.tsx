import React from 'react';
import type { SlideIndexEntry } from '../types';
import { formatMs } from '../utils';

interface SlideGalleryProps {
    slides: SlideIndexEntry[];
    onSlideClick: (index: number) => void;
}

const SlideGallery: React.FC<SlideGalleryProps> = ({ slides, onSlideClick }) => {
    return (
        <section className="gallery-section">
            <h2>📌 Detected Slides ({slides.length})</h2>
            <div className="filmstrip">
                {slides.map((slide, i) => (
                    <div key={i} className="slide-item">
                        <img 
                            src={slide.url} 
                            alt={`Slide ${i}`} 
                            loading="lazy" 
                            style={{ cursor: 'pointer' }}
                            onClick={() => onSlideClick(i)}
                        />
                        <span className="timestamp">
                            {formatMs(Math.floor(slide.startMs / 1000) * 1000)}
                        </span>
                    </div>
                ))}
            </div>
        </section>
    );
};

export default SlideGallery;
