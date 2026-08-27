import { Box } from '@mui/material';

const PALETTE = ['#1a73e8', '#e8710a', '#188038', '#c5221f', '#7b1fa2', '#00796b', '#5d4037', '#455a64'];

/**
 * Company/medicine logo. Shows the real logo image when a URL is available;
 * otherwise falls back to a colored first-letter avatar. The letter avatar is
 * always rendered underneath, so a broken image URL degrades cleanly back to
 * the letter instead of leaving an empty cell.
 */
export default function MedicineLogo({ src, text, size = 32 }) {
  const initial = (text || '').trim().charAt(0).toUpperCase() || '?';
  const colorIdx = (initial.charCodeAt(0) || 0) % PALETTE.length;
  const radius = size >= 36 ? '8px' : '6px';

  return (
    <Box sx={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <Box sx={{
        position: 'absolute', inset: 0, borderRadius: radius, bgcolor: PALETTE[colorIdx],
        color: '#fff', fontWeight: 700, fontSize: Math.max(11, Math.round(size * 0.44)),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {initial}
      </Box>
      {src && (
        <Box
          component="img"
          src={src}
          alt=""
          loading="lazy"
          sx={{
            position: 'absolute', inset: 0, width: size, height: size, borderRadius: radius,
            objectFit: 'contain', bgcolor: '#fff', border: '1px solid #e0e6e4', p: '1px',
          }}
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      )}
    </Box>
  );
}