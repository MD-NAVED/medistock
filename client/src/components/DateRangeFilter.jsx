import { Box, Chip, IconButton, TextField, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

// Shared date-range filter for history lists: one-tap quick ranges plus
// optional From/To pickers. value = { from: 'YYYY-MM-DD'|'', to: 'YYYY-MM-DD'|'' }.
export default function DateRangeFilter({ value, onChange, title }) {
  const localDate = (ms) => new Date(ms).toLocaleDateString('en-CA');
  const today = localDate(Date.now());
  const yesterday = localDate(Date.now() - 86400000);

  const chips = [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: yesterday, to: yesterday },
    { label: 'Last 7 days', from: localDate(Date.now() - 6 * 86400000), to: today },
    { label: 'This month', from: today.slice(0, 8) + '01', to: today },
  ];
  const active = !!(value.from || value.to);
  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
      {title && <Typography variant="body2" color="text.secondary">{title}</Typography>}
      {chips.map((c) => (
        <Chip
          key={c.label} size="small" label={c.label}
          color={value.from === c.from && value.to === c.to ? 'primary' : 'outlined'}
          onClick={() => onChange({ from: c.from, to: c.to })}
        />
      ))}
      <TextField
        size="small" type="date" label="From" value={value.from}
        InputLabelProps={{ shrink: true }} onChange={(e) => set({ from: e.target.value })}
        sx={{ width: { xs: 130, sm: 150 }, bgcolor: 'background.paper', borderRadius: 1 }}
      />
      <TextField
        size="small" type="date" label="To" value={value.to}
        InputLabelProps={{ shrink: true }} onChange={(e) => set({ to: e.target.value })}
        sx={{ width: { xs: 130, sm: 150 }, bgcolor: 'background.paper', borderRadius: 1 }}
      />
      {active && (
        <IconButton size="small" aria-label="Clear date filter" title="Clear date filter"
          onClick={() => onChange({ from: '', to: '' })}>
          <CloseIcon fontSize="small" />
        </IconButton>
      )}
    </Box>
  );
}
