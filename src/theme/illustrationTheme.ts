import { theme } from 'antd';
import type { ConfigProviderProps } from 'antd';
import type { ThemeMode } from '../types';

export function buildIllustrationTheme(mode: ThemeMode): ConfigProviderProps {
  const isDark = mode === 'dark';

  return {
    theme: {
      algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: {
        colorText: isDark ? '#F5F5F7' : '#1D1D1F',
        colorTextSecondary: isDark ? '#A1A1A6' : '#686870',
        colorPrimary: '#2F8F57',
        colorSuccess: '#2F8F57',
        colorWarning: isDark ? '#D5A458' : '#B67A21',
        colorError: '#C54D3D',
        colorInfo: isDark ? '#6BA7DE' : '#2D79BA',
        colorBorder: isDark ? '#2C302D' : '#D9DED6',
        colorBorderSecondary: isDark ? '#232723' : '#E6EBE2',
        lineWidth: 1,
        lineWidthBold: 2,
        borderRadius: 10,
        borderRadiusLG: 14,
        borderRadiusSM: 8,
        controlHeight: 36,
        controlHeightSM: 30,
        controlHeightLG: 44,
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
        fontFamilyCode: '"SF Mono", "Fira Code", monospace',
        fontSize: 14,
        fontWeightStrong: 600,
        colorBgBase: isDark ? '#0F1110' : '#F4F1E8',
        colorBgContainer: isDark ? '#191B19' : '#FFFDF8',
        colorBgElevated: isDark ? '#20231F' : '#FFFDF8',
      },
      components: {
        Button: {
          primaryShadow: 'none',
          dangerShadow: 'none',
          defaultShadow: 'none',
          fontWeight: 600,
          borderRadius: 10,
          borderColorDisabled: isDark ? '#2C302D' : '#D9DED6',
        },
        Modal: {
          boxShadow: 'none',
        },
        Card: {
          boxShadow: isDark
            ? '0 20px 44px rgba(0, 0, 0, 0.38)'
            : '0 18px 44px rgba(29, 29, 31, 0.08)',
          colorBgContainer: isDark ? '#191B19' : '#FFFDF8',
        },
        Tooltip: {
          colorBorder: isDark ? '#2C302D' : '#D9DED6',
          colorBgSpotlight: isDark
            ? 'rgba(20, 23, 21, 0.96)'
            : 'rgba(24, 35, 28, 0.94)',
          borderRadius: 10,
        },
        Select: {
          optionSelectedBg: isDark ? 'rgba(83, 185, 119, 0.14)' : '#EDF6EF',
        },
        Input: {
          activeShadow: isDark
            ? '0 0 0 3px rgba(83, 185, 119, 0.2)'
            : '0 0 0 3px rgba(47, 143, 87, 0.14)',
        },
        Drawer: {
          colorBgElevated: isDark ? '#191B19' : '#FFFDF8',
        },
      },
    },
  };
}

const illustrationTheme = buildIllustrationTheme('light');

export default illustrationTheme;
