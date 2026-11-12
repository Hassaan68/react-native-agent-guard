import React from 'react';

export const View = (props: Record<string, unknown>) =>
  React.createElement('View', props, props.children as React.ReactNode);

export const Text = (props: Record<string, unknown>) =>
  React.createElement('Text', props, props.children as React.ReactNode);

export const Modal = (props: Record<string, unknown>) =>
  props.visible
    ? React.createElement('Modal', props, props.children as React.ReactNode)
    : null;

export const TouchableOpacity = (props: Record<string, unknown>) =>
  React.createElement('TouchableOpacity', props, props.children as React.ReactNode);

export const ScrollView = (props: Record<string, unknown>) =>
  React.createElement('ScrollView', props, props.children as React.ReactNode);

export const StyleSheet = {
  create: <T extends Record<string, unknown>>(styles: T): T => styles,
};

export const Appearance = {
  getColorScheme: (): 'light' | 'dark' => 'light',
};

export const useColorScheme = (): 'light' | 'dark' => 'light';
