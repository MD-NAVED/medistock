import { createTheme } from '@mui/material/styles';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#00695c', light: '#4db6ac', dark: '#003d33' },
    secondary: { main: '#00897b' },
    success: { main: '#2e7d32' },
    warning: { main: '#ed6c02' },
    error: { main: '#d32f2f' },
    background: { default: '#f1f5f4', paper: '#ffffff' },
  },
  typography: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    h5: { fontWeight: 700 },
    h6: { fontWeight: 700 },
    subtitle2: { fontWeight: 600 },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        contained: {
          transition: 'transform 150ms ease-out',
          '&:active': {
            transform: 'scale(0.97)',
          },
        },
      },
    },
    MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { border: '1px solid #e0e6e4' } } },
  },
});

export default theme;
