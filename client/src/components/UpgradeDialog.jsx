import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, Stack, Chip } from '@mui/material';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';
import LockIcon from '@mui/icons-material/Lock';
import { useNavigate } from 'react-router-dom';
import { FEATURE_LABELS } from '../tiers';

/**
 * Shown when the user taps a feature their plan does not include (or when the
 * server answers 402 feature_locked). Points them at the Subscription page.
 */
export default function UpgradeDialog({ open, onClose, feature, requiredTier }) {
  const navigate = useNavigate();
  const label = FEATURE_LABELS[feature] || 'This feature';

  const go = () => {
    onClose?.();
    navigate('/subscription');
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <LockIcon color="warning" />
        Upgrade required
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <Typography>
            <strong>{label}</strong> is not part of your current plan.
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              size="small"
              color="primary"
              icon={<WorkspacePremiumIcon />}
              label={`Available in ${String(requiredTier || 'pro').toUpperCase()}`}
            />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Upgrade on the Subscription page — your store unlocks the moment payment succeeds. Your existing data is never lost.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Not now</Button>
        <Button onClick={go} variant="contained">View Plans</Button>
      </DialogActions>
    </Dialog>
  );
}
