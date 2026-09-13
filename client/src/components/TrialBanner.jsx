import { Alert, Button } from '@mui/material';
import { Link } from 'react-router-dom';
import CardGiftcardIcon from '@mui/icons-material/CardGiftcard';
import { useAuth } from '../auth';
import { getTrialDaysRemaining } from '../tiers';

export default function TrialBanner({ showUpgradeButton = true, sx = {} }) {
  const { user } = useAuth();
  const days = getTrialDaysRemaining(user);
  if (days === null) return null;

  // green >= 7, yellow < 7, red < 3
  const severity = days >= 7 ? 'success' : days >= 3 ? 'warning' : 'error';
  const text = days === 0
    ? '🎁 Free Trial: Last day remaining'
    : `🎁 Free Trial: ${days} ${days === 1 ? 'day' : 'days'} remaining`;

  return (
    <Alert
      severity={severity}
      icon={<CardGiftcardIcon />}
      action={
        showUpgradeButton ? (
          <Button color="inherit" size="small" component={Link} to="/subscription" sx={{ fontWeight: 700, textTransform: 'none' }}>
            Upgrade Plan
          </Button>
        ) : null
      }
      sx={{ mb: 2.5, fontWeight: 600, ...sx }}
    >
      {text}
    </Alert>
  );
}
