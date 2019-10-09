import React from 'react';
import Head from 'next/head';
import Layout from '../components/Layout';
import { useMeQuery } from '../generated/graphql';
import { useApolloClient } from '@apollo/react-hooks';

interface Props {}

const Home: React.FC<Props> = () => {
  const { data } = useMeQuery();

  if (!data) {
    return (
      <Layout>
        <div />
      </Layout>
    );
  }

  return (
    <Layout>
      <Head>
        <title>Dorya</title>
      </Head>
    </Layout>
  );
};

export default Home;
