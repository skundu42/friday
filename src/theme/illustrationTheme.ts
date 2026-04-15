import { theme } from 'antd';
import type { ConfigProviderProps } from 'antd';
import type { ThemeMode } from '../types';

export function buildIllustrationTheme(mode: ThemeMode): ConfigProviderProps {
  const isDark = mode === 'dark';

  return {
    theme: {
      algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: {
        colorText: isDark ? '#F4F4F4' : '#17261C',
        colorTextSecondary: isDark ? '#B5B5B5' : '#5D6B61',
        colorPrimary: '#2F8F57',
        colorSuccess: '#2F8F57',
        colorWarning: isDark ? '#D5A458' : '#B67A21',
        colorError: '#C54D3D',
        colorInfo: '#4D93D2',
        colorBorder: isDark ? '#292929' : '#D8DED5',
        colorBorderSecondary: isDark ? '#202020' : '#E7EBE4',
        lineWidth: 1,
        lineWidthBold: 2,
        borderRadius: 16,
        borderRadiusLG: 22,
        borderRadiusSM: 12,
        controlHeight: 40,
        controlHeightSM: 34,
        controlHeightLG: 48,
        fontFamily: '"Sora", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontFamilyCode: '"SF Mono", "Fira Code", monospace',
        fontSize: 15,
        fontWeightStrong: 600,
        colorBgBase: isDark ? '#050505' : '#F5F2E8',
        colorBgContainer: isDark ? '#111111' : '#FFFFFF',
        colorBgElevated: isDark ? '#171717' : '#FFFDF8',
      },
      components: {
        Button: {
          primaryShadow: 'none',
          dangerShadow: 'none',
          defaultShadow: 'none',
          fontWeight: 600,
          borderColorDisabled: isDark ? '#292929' : '#D8DED5',
        },
        Modal: {
          boxShadow: 'none',
        },
        Card: {
          boxShadow: isDark
            ? '0 18px 44px rgba(0, 0, 0, 0.45)'
            : '0 12px 32px rgba(23, 38, 28, 0.08)',
          colorBgContainer: isDark ? '#111111' : '#FFFFFF',
        },
        Tooltip: {
          colorBorder: isDark ? '#292929' : '#D8DED5',
          colorBgSpotlight: isDark
            ? 'rgba(6, 6, 6, 0.96)'
            : 'rgba(24, 35, 28, 0.92)',
          borderRadius: 12,
        },
        Select: {
          optionSelectedBg: isDark ? 'rgba(83, 185, 119, 0.12)' : '#EDF6EF',
        },
        Input: {
          activeShadow: isDark
            ? '0 0 0 2px rgba(47, 143, 87, 0.18)'
            : '0 0 0 2px rgba(47, 143, 87, 0.12)',
        },
        Drawer: {
          colorBgElevated: isDark ? '#131313' : '#FFFDF8',
        },
      },
    },
  };
}

const illustrationTheme = buildIllustrationTheme('light');

export default illustrationTheme;
