import React from 'react';
import PropTypes from 'prop-types';
import styles from './styles.module.css';
import logo from "./logo.svg"

export default function Header(props) {
  const { onClick } = props;

  return (
    <div className={styles.root}>
      <div className={styles.logo}>
        <h1>
          <span className={styles.name} onClick={onClick}>
            Slack Vibe&nbsp;&nbsp;<span role='img' aria-label=''>🎉</span>
          </span>
          <span className={styles.attribution}>by</span>
          <span><img src={logo} alt='Cube.js' /></span>
        </h1>
        <div className={styles.description}>An&nbsp;open source dashboard of&nbsp;public activity
          in&nbsp;a&nbsp;Slack workspace of&nbsp;an&nbsp;open community or&nbsp;a&nbsp;private team
        </div>
        <ul className={styles.buttons}>
          <li>
            <a href='https://github.com/cube-js/cube.js/tree/master/examples/slack-vibe'
               className='button'
               target='_blank'
               rel='noopener noreferrer'
            >
              Browse on GitHub
            </a>
          </li>
          <li>
            <a href='https://heroku.com/deploy?template=?'
               className='button'
               target='_blank'
               rel='noopener noreferrer'
            >
              Deploy to Heroku
            </a>
          </li>
          <li>
            <a href='https://hub.docker.com/r/?/?/'
               className='button'
               target='_blank'
               rel='noopener noreferrer'
            >
              Get Docker container
            </a>
          </li>
        </ul>
      </div>
    </div>
  )
}

Header.propTypes = {
  onClick: PropTypes.func,
};