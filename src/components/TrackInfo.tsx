import React from 'react';
import { Music } from 'lucide-react';

interface TrackInfoProps {
  title: string;
  artist: string;
  albumArt?: string;
}

export const TrackInfo: React.FC<TrackInfoProps> = ({ title, artist, albumArt }) => {
  return (
    <div className="track-info-container">
      {albumArt ? (
        <img src={albumArt} alt={title} className="album-cover" />
      ) : (
        <div className="album-cover-placeholder">
          <Music size={24} />
        </div>
      )}
      <div className="track-details">
        <span className="track-title" title={title}>
          {title || 'YouTube Music'}
        </span>
        <span className="track-artist" title={artist}>
          {artist || '未在播放'}
        </span>
      </div>
    </div>
  );
};
